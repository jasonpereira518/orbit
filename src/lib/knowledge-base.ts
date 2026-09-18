import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { getDb, rowsOf } from "@/db";
import { contacts, interactions } from "@/db/schema";
import {
  knownInteractionTypeValues,
  normalizeInteractionType,
} from "@/lib/interaction-types";
import type {
  KnowledgeBasePayload,
  KnowledgeEntry,
  KnowledgeKind,
  KnowledgeStats,
} from "@/lib/knowledge-base-types";

/**
 * The /knowledge page's data, bounded (audit B4).
 *
 * The page renders at most 400 entries, newest first, and every contact-derived entry is
 * dated with the contact's `updated_at` — so the 400 most recently updated contacts that
 * HAVE a summary, notes or key facts produce exactly the entries the old whole-account read
 * did. Text columns are truncated in SQL (`left(...)`) so a multi-KB note never crosses the
 * wire to be sliced in JavaScript; `profile_image_url` is never selected. Stats come from one
 * aggregate instead of from the whole account in memory.
 */
export const KNOWLEDGE_ENTRY_LIMIT = 400;
const INTERACTION_LIMIT = 500;
const INTERACTION_ENTRY_LIMIT = 300;
const SNIPPET_CHARS = 420;

type ContactName = {
  id: string;
  fullName: string;
  preferredName: string | null;
  company: string | null;
  title: string | null;
};

function iso(d: Date | null | undefined) {
  return d ? new Date(d).toISOString() : null;
}

/** Legacy values (`meeting_note`, `outreach`, `coffee`) bucket with their modern equivalents. */
function kindOf(type: string | null, hasRawNotes: boolean): KnowledgeKind {
  if (!type && hasRawNotes) return "note";
  const canonical = normalizeInteractionType(type);
  if (canonical === "linkedin_message" || canonical === "message") return "message";
  if (canonical === "meeting" || canonical === "in_person" || canonical === "event") return "meeting";
  return "note";
}

function snippet(text: string | null | undefined) {
  return (text ?? "").trim().slice(0, SNIPPET_CHARS);
}

/**
 * Raw `interaction_type` values that bucket into each knowledge kind.
 *
 * Derived by running every known value through the same `normalizeInteractionType` the
 * display path uses, rather than hand-copying the legacy alias map into a SQL filter. The
 * two would drift the first time somebody added an alias, and the symptom — a stat quietly
 * undercounting `meeting_note` — is invisible.
 */
function rawTypesFor(kind: "message" | "meeting"): string[] {
  return knownInteractionTypeValues().filter((raw) => {
    const canonical = normalizeInteractionType(raw);
    if (kind === "message") {
      return canonical === "linkedin_message" || canonical === "message";
    }
    return canonical === "meeting" || canonical === "in_person" || canonical === "event";
  });
}

export type KnowledgeQuery = {
  q?: string;
  kind?: KnowledgeKind | "all";
};

export async function loadKnowledgeBase(
  userId: string,
  options?: KnowledgeQuery
): Promise<KnowledgeBasePayload> {
  const db = await getDb();

  const q = options?.q?.trim() ?? "";
  const like = q ? `%${q}%` : null;
  const kindFilter = options?.kind && options.kind !== "all" ? options.kind : null;
  const messageTypes = rawTypesFor("message");
  const meetingTypes = rawTypesFor("meeting");

  /**
   * Counting the kinds in SQL, not from the sample above.
   *
   * `messages`, `notes` and `meetings` were derived by bucketing `interactionRows`, which is
   * capped at INTERACTION_LIMIT — so "Messages" silently stopped at 500 however many the
   * user had, and the page presented that sample size as a total.
   */
  const kindCounts = rowsOf<{
    messages: number;
    meetings: number;
    notes: number;
    with_content: number;
  }>(
    await db.execute(sql`
      SELECT
        count(*) filter (where ${inArray(interactions.interactionType, messageTypes)})::int AS messages,
        count(*) filter (where ${inArray(interactions.interactionType, meetingTypes)})::int AS meetings,
        count(*) filter (
          where ${interactions.interactionType} is null
             or not ${inArray(interactions.interactionType, [...messageTypes, ...meetingTypes])}
        )::int AS notes,
        count(*) filter (
          where coalesce(btrim(coalesce(ai_summary, raw_notes)), '') <> ''
        )::int AS with_content
      FROM interactions WHERE user_id = ${userId}
    `)
  )[0];

  const [statsResult, contactRows, interactionRows] = await Promise.all([
    db.execute(sql`
      SELECT count(*)::int AS people,
             (count(*) FILTER (WHERE btrim(coalesce(ai_summary, '')) <> ''))::int AS with_summary,
             (count(*) FILTER (WHERE jsonb_array_length(coalesce(key_facts, '[]'::jsonb)) > 0))::int AS with_key_facts,
             (count(*) FILTER (WHERE btrim(coalesce(notes, '')) <> ''))::int AS with_notes,
             coalesce(sum(jsonb_array_length(coalesce(key_facts, '[]'::jsonb))), 0)::int AS fact_count,
             (SELECT count(*)::int FROM contact_embeddings WHERE user_id = ${userId}) AS embeddings
        FROM contacts
       WHERE user_id = ${userId}
    `),
    db
      .select({
        id: contacts.id,
        fullName: contacts.fullName,
        preferredName: contacts.preferredName,
        company: contacts.company,
        title: contacts.title,
        source: contacts.source,
        updatedAt: contacts.updatedAt,
        keyFacts: contacts.keyFacts,
        // 480 not 420: the old code trimmed before slicing, so leave room for leading space.
        aiSummary: sql<string | null>`left(${contacts.aiSummary}::text, 480)`,
        notes: sql<string | null>`left(${contacts.notes}::text, 480)`,
      })
      .from(contacts)
      .where(
        and(
          eq(contacts.userId, userId),
          // No coalesce(col, ...) here: NULL just drops out of the OR, and a bare "notes",
          // would trip the page-budget check that scans every statement for a bare notes column.
          sql`(btrim(${contacts.aiSummary}) <> '' OR btrim(${contacts.notes}) <> '' OR jsonb_array_length(${contacts.keyFacts}) > 0)`,
          // The search runs HERE, not in the browser. It used to filter whichever entries had
          // already been shipped, so a note from two years ago produced "No matches for that
          // search" while sitting in the table.
          like
            ? sql`(${contacts.fullName} ILIKE ${like} OR ${contacts.aiSummary} ILIKE ${like}
                   OR ${contacts.notes} ILIKE ${like} OR ${contacts.keyFacts}::text ILIKE ${like})`
            : undefined,
          // `summary`, `note` and `key_fact` are the only kinds a contact row produces.
          kindFilter === "message" || kindFilter === "meeting" ? sql`false` : undefined
        )
      )
      .orderBy(desc(contacts.updatedAt), desc(contacts.id))
      .limit(KNOWLEDGE_ENTRY_LIMIT),
    db
      .select({
        id: interactions.id,
        contactId: interactions.contactId,
        interactionType: interactions.interactionType,
        source: interactions.source,
        interactionDate: interactions.interactionDate,
        aiSummary: sql<string | null>`left(${interactions.aiSummary}::text, 480)`,
        rawNotes: sql<string | null>`left(${interactions.rawNotes}::text, 480)`,
      })
      .from(interactions)
      .where(
        and(
          eq(interactions.userId, userId),
          like
            ? sql`(${interactions.aiSummary} ILIKE ${like} OR ${interactions.rawNotes} ILIKE ${like}
                   OR exists (select 1 from contacts c where c.id = ${interactions.contactId}
                              and (c.full_name ILIKE ${like} OR c.preferred_name ILIKE ${like})))`
            : undefined,
          // Applied in the WHERE, not after the LIMIT: filtering the page in JavaScript would
          // search only the newest rows for matching kinds, so asking for "notes" on an
          // account whose recent history is all messages returned nothing at all.
          kindFilter === "message"
            ? inArray(interactions.interactionType, messageTypes)
            : kindFilter === "meeting"
              ? inArray(interactions.interactionType, meetingTypes)
              : kindFilter === "note"
                ? sql`(${interactions.interactionType} is null
                       or not ${inArray(interactions.interactionType, [...messageTypes, ...meetingTypes])})`
                : kindFilter
                  ? sql`false`
                  : undefined
        )
      )
      .orderBy(desc(interactions.interactionDate))
      .limit(INTERACTION_LIMIT),
  ]);

  const s = rowsOf<{
    people: number;
    with_summary: number;
    with_key_facts: number;
    with_notes: number;
    fact_count: number;
    embeddings: number;
  }>(statsResult)[0];

  // Names for the interactions that become entries. Most are already in `contactRows`; the
  // rest come from one by-id read, bounded by the same 300 the entries are.
  const names = new Map<string, ContactName>(contactRows.map((c) => [c.id, c]));
  const entryInteractions = interactionRows.slice(0, INTERACTION_ENTRY_LIMIT);
  const missing = [...new Set(entryInteractions.map((i) => i.contactId))].filter((id) => !names.has(id));
  if (missing.length > 0) {
    const extra = await db
      .select({
        id: contacts.id,
        fullName: contacts.fullName,
        preferredName: contacts.preferredName,
        company: contacts.company,
        title: contacts.title,
      })
      .from(contacts)
      .where(and(eq(contacts.userId, userId), inArray(contacts.id, missing)))
      .limit(INTERACTION_ENTRY_LIMIT);
    for (const c of extra) names.set(c.id, c);
  }

  const stats: KnowledgeStats = {
    people: Number(s?.people ?? 0),
    messages: Number(kindCounts?.messages ?? 0),
    notes: Number(kindCounts?.notes ?? 0) + Number(s?.with_notes ?? 0),
    meetings: Number(kindCounts?.meetings ?? 0),
    withSummary: Number(s?.with_summary ?? 0),
    withKeyFacts: Number(s?.with_key_facts ?? 0),
    embeddings: Number(s?.embeddings ?? 0),
    // Counted, not derived: summing messages+notes+meetings omits summaries and key facts,
    // which is how the footer came to read "Showing 94 of 64 items".
    entriesTotal:
      Number(kindCounts?.with_content ?? 0) +
      Number(s?.with_summary ?? 0) +
      Number(s?.with_notes ?? 0) +
      Number(s?.fact_count ?? 0),
  };

  const entries: KnowledgeEntry[] = [];
  entryInteractions.forEach((i, index) => {
    const contact = names.get(i.contactId);
    if (!contact) return;
    const text = snippet(i.aiSummary || i.rawNotes);
    if (!text) return;
    entries.push({
      id: `interaction:${i.id}`,
      kind: kindOf(i.interactionType, Boolean(i.rawNotes)),
      contactId: contact.id,
      contactName: contact.preferredName || contact.fullName,
      company: contact.company,
      title: contact.title,
      snippet: text,
      date: iso(i.interactionDate),
      source: i.source,
    });
  });

  for (const c of contactRows) {
    const base = {
      contactId: c.id,
      contactName: c.preferredName || c.fullName,
      company: c.company,
      title: c.title,
      date: iso(c.updatedAt),
    };
    if (snippet(c.aiSummary)) {
      entries.push({ ...base, id: `summary:${c.id}`, kind: "summary", snippet: snippet(c.aiSummary), source: c.source });
    }
    if (snippet(c.notes)) {
      entries.push({ ...base, id: `notes:${c.id}`, kind: "note", snippet: snippet(c.notes), source: "profile_notes" });
    }
    for (const fact of c.keyFacts || []) {
      if (!fact.trim()) continue;
      entries.push({ ...base, id: `fact:${c.id}:${fact.slice(0, 40)}`, kind: "key_fact", snippet: snippet(fact), source: "key_facts" });
    }
  }

  entries.sort((a, b) => (b.date ? Date.parse(b.date) : 0) - (a.date ? Date.parse(a.date) : 0));
  return { stats, entries: entries.slice(0, KNOWLEDGE_ENTRY_LIMIT) };
}
