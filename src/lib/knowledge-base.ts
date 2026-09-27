import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { getDb, rowsOf } from "@/db";
import { contacts, interactions } from "@/db/schema";
import { normalizeInteractionType } from "@/lib/interaction-types";
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

export async function loadKnowledgeBase(userId: string): Promise<KnowledgeBasePayload> {
  const db = await getDb();

  const [statsResult, contactRows, interactionRows] = await Promise.all([
    db.execute(sql`
      SELECT count(*)::int AS people,
             (count(*) FILTER (WHERE btrim(coalesce(ai_summary, '')) <> ''))::int AS with_summary,
             (count(*) FILTER (WHERE jsonb_array_length(coalesce(key_facts, '[]'::jsonb)) > 0))::int AS with_key_facts,
             (count(*) FILTER (WHERE btrim(coalesce(notes, '')) <> ''))::int AS with_notes,
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
          sql`(btrim(${contacts.aiSummary}) <> '' OR btrim(${contacts.notes}) <> '' OR jsonb_array_length(${contacts.keyFacts}) > 0)`
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
      .where(eq(interactions.userId, userId))
      .orderBy(desc(interactions.interactionDate))
      .limit(INTERACTION_LIMIT),
  ]);

  const s = rowsOf<{
    people: number;
    with_summary: number;
    with_key_facts: number;
    with_notes: number;
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

  const kinds = interactionRows.map((i) => kindOf(i.interactionType, Boolean(i.rawNotes)));
  const stats: KnowledgeStats = {
    people: Number(s?.people ?? 0),
    messages: kinds.filter((k) => k === "message").length,
    notes: kinds.filter((k) => k === "note").length + Number(s?.with_notes ?? 0),
    meetings: kinds.filter((k) => k === "meeting").length,
    withSummary: Number(s?.with_summary ?? 0),
    withKeyFacts: Number(s?.with_key_facts ?? 0),
    embeddings: Number(s?.embeddings ?? 0),
  };

  const entries: KnowledgeEntry[] = [];
  entryInteractions.forEach((i, index) => {
    const contact = names.get(i.contactId);
    if (!contact) return;
    const text = snippet(i.aiSummary || i.rawNotes);
    if (!text) return;
    entries.push({
      id: `interaction:${i.id}`,
      kind: kinds[index],
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
