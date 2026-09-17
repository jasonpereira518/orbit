"use server";

import { desc, eq, inArray, sql } from "drizzle-orm";
import { getDb, rowsOf } from "@/db";
import {
  contactEmbeddings,
  contacts,
  interactions,
} from "@/db/schema";
import {
  KNOWLEDGE_PAGE_SIZE,
  type KnowledgeBasePayload,
  type KnowledgeEntry,
  type KnowledgeKind,
  type KnowledgeQuery,
  type KnowledgeStats,
} from "@/lib/knowledge-page";
import { requireUserForSurface } from "@/lib/plan-guards";
import {
  knownInteractionTypeValues,
  normalizeInteractionType,
} from "@/lib/interaction-types";

function iso(d: Date | null | undefined) {
  return d ? new Date(d).toISOString() : null;
}

/**
 * When this knowledge was actually acquired, rather than when the row was last written.
 *
 * All three profile-derived entry kinds used `contacts.updatedAt`, which is "now" for
 * freshly seeded data and is bumped by ANY write to the contact — a tag change, a
 * follow-up reschedule, an avatar backfill. On a 24-person network that stamped 57 of 95
 * entries with today's date, so the reverse-chronological list opened with a wall of
 * profile fragments and buried every real conversation beneath them.
 *
 * The last interaction is the honest answer for a summary, a note, or a key fact: it is
 * the conversation the knowledge came out of. `createdAt` covers a contact nobody has
 * spoken to yet.
 */
function knowledgeDate(c: {
  lastInteractionAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}) {
  return iso(c.lastInteractionAt ?? c.createdAt ?? c.updatedAt);
}

/**
 * Bucketed through the canonical vocabulary so the legacy values still in the table
 * (`meeting_note`, `outreach`, `coffee`) land with their modern equivalents instead of
 * splitting the same kind of interaction across two counts.
 */
function kindOf(type: string | null, rawNotes: string | null): KnowledgeKind {
  if (!type && rawNotes) return "note";
  const canonical = normalizeInteractionType(type);
  if (canonical === "linkedin_message" || canonical === "message") return "message";
  if (canonical === "meeting" || canonical === "in_person" || canonical === "event") {
    return "meeting";
  }
  return "note";
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

export async function getKnowledgeBase(
  options?: KnowledgeQuery
): Promise<KnowledgeBasePayload> {
  const userId = await requireUserForSurface("page.knowledge");
  const db = await getDb();

  const q = options?.q?.trim() ?? "";
  const like = q ? `%${q}%` : null;
  const kindFilter = options?.kind && options.kind !== "all" ? options.kind : null;

  const messageTypes = rawTypesFor("message");
  const meetingTypes = rawTypesFor("meeting");

  /**
   * Counted in SQL rather than by filtering rows in JavaScript.
   *
   * These stats used to be derived from the same 500-row sample the page rendered, so
   * "Messages" silently stopped at 500 however many a user actually had — a number the page
   * presented as a total. Counting in the database is both correct and cheaper than the
   * scan it replaces.
   */
  const [statRow, contactStatRow, embeddingCountRow] = await Promise.all([
    db.execute(sql`
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
    `),
    db.execute(sql`
      SELECT
        count(*)::int AS people,
        count(*) filter (where coalesce(btrim(ai_summary), '') <> '')::int AS with_summary,
        count(*) filter (where coalesce(jsonb_array_length(key_facts), 0) > 0)::int AS with_key_facts,
        count(*) filter (where coalesce(btrim(notes), '') <> '')::int AS with_notes,
        coalesce(sum(coalesce(jsonb_array_length(key_facts), 0)), 0)::int AS fact_count
      FROM contacts WHERE user_id = ${userId}
    `),
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(contactEmbeddings)
      .where(eq(contactEmbeddings.userId, userId)),
  ]);

  const iStats = rowsOf<{
    messages: number;
    meetings: number;
    notes: number;
    with_content: number;
  }>(statRow)[0];
  const cStats = rowsOf<{
    people: number;
    with_summary: number;
    with_key_facts: number;
    with_notes: number;
    fact_count: number;
  }>(contactStatRow)[0];

  const stats: KnowledgeStats = {
    people: Number(cStats?.people ?? 0),
    messages: Number(iStats?.messages ?? 0),
    notes: Number(iStats?.notes ?? 0) + Number(cStats?.with_notes ?? 0),
    meetings: Number(iStats?.meetings ?? 0),
    withSummary: Number(cStats?.with_summary ?? 0),
    withKeyFacts: Number(cStats?.with_key_facts ?? 0),
    embeddings: Number(embeddingCountRow[0]?.count ?? 0),
    entriesTotal:
      Number(iStats?.with_content ?? 0) +
      Number(cStats?.with_summary ?? 0) +
      Number(cStats?.with_notes ?? 0) +
      Number(cStats?.fact_count ?? 0),
  };

  const entries: KnowledgeEntry[] = [];

  /**
   * Interaction-derived entries, filtered and joined in the database.
   *
   * The search used to run in the browser over whichever 300 entries happened to be sent,
   * so a note from two years ago produced "No matches for that search" while sitting in the
   * table. Matching on the contact's name too, because people search the knowledge base by
   * who they spoke to at least as often as by what was said.
   */
  // The kind filter belongs in the WHERE clause, not in a JS pass over the results. Applied
  // after the LIMIT it would search only the newest page for matching kinds — so asking for
  // "notes" on an account whose recent history is all messages returned nothing at all,
  // which is the same shape of bug as the client-side search this replaces.
  // Written against the `i.` alias the query below uses. Drizzle's `inArray` emits the full
  // table name, which Postgres rejects once the table is aliased.
  const typeList = (values: string[]) =>
    sql.join(
      values.map((v) => sql`${v}`),
      sql`, `
    );
  const interactionKindFilter =
    kindFilter === "message"
      ? sql`i.interaction_type in (${typeList(messageTypes)})`
      : kindFilter === "meeting"
        ? sql`i.interaction_type in (${typeList(meetingTypes)})`
        : kindFilter === "note"
          ? sql`(i.interaction_type is null
                 or i.interaction_type not in (${typeList([...messageTypes, ...meetingTypes])}))`
          : null;

  // `summary` and `key_fact` exist only on contacts, so an interaction query would be wasted.
  const wantsInteractions = kindFilter !== "summary" && kindFilter !== "key_fact";
  if (wantsInteractions) {
    const rows = rowsOf<{
      id: string;
      interaction_type: string | null;
      raw_notes: string | null;
      ai_summary: string | null;
      interaction_date: Date | null;
      source: string | null;
      contact_id: string;
      full_name: string;
      preferred_name: string | null;
      company: string | null;
      title: string | null;
    }>(
      await db.execute(sql`
        SELECT i.id, i.interaction_type, i.raw_notes, i.ai_summary, i.interaction_date,
               i.source, c.id AS contact_id, c.full_name, c.preferred_name, c.company, c.title
        FROM interactions i
        JOIN contacts c ON c.id = i.contact_id
        WHERE i.user_id = ${userId}
          AND coalesce(btrim(coalesce(i.ai_summary, i.raw_notes)), '') <> ''
          ${
            like
              ? sql`AND (i.ai_summary ILIKE ${like} OR i.raw_notes ILIKE ${like}
                         OR c.full_name ILIKE ${like} OR c.preferred_name ILIKE ${like})`
              : sql``
          }
          ${interactionKindFilter ? sql`AND ${interactionKindFilter}` : sql``}
        ORDER BY i.interaction_date DESC NULLS LAST, i.id DESC
        LIMIT ${KNOWLEDGE_PAGE_SIZE}
      `)
    );

    for (const i of rows) {
      const snippet = (i.ai_summary || i.raw_notes || "").trim();
      if (!snippet) continue;
      // The SQL already restricted the kinds; this only guards against the two bucketings
      // disagreeing, which would otherwise show up as a row under the wrong filter.
      const kind = kindOf(i.interaction_type, i.raw_notes);
      if (kindFilter && kind !== kindFilter) continue;
      entries.push({
        id: `interaction:${i.id}`,
        kind,
        contactId: i.contact_id,
        contactName: i.preferred_name || i.full_name,
        company: i.company,
        title: i.title,
        snippet: snippet.slice(0, 420),
        date: iso(i.interaction_date),
        source: i.source,
      });
    }
  }

  /**
   * Contact-derived entries: the summary, the profile notes, and each key fact.
   *
   * Projected rather than `findMany` with no `columns`, which loaded every column of every
   * contact — including `profile_image_url`, a base64 data URL up to 120KB that this page
   * never renders. That one column was most of the bytes this query moved.
   */
  const wantsContactRows = kindFilter !== "message" && kindFilter !== "meeting";
  if (wantsContactRows) {
    const contactRows = await db.query.contacts.findMany({
      where: like
        ? sql`${contacts.userId} = ${userId} AND (
              ${contacts.fullName} ILIKE ${like}
              OR ${contacts.aiSummary} ILIKE ${like}
              OR ${contacts.notes} ILIKE ${like}
              OR ${contacts.keyFacts}::text ILIKE ${like}
            )`
        : eq(contacts.userId, userId),
      columns: {
        id: true,
        fullName: true,
        preferredName: true,
        company: true,
        title: true,
        aiSummary: true,
        notes: true,
        keyFacts: true,
        source: true,
        lastInteractionAt: true,
        createdAt: true,
        updatedAt: true,
      },
      orderBy: [desc(contacts.lastInteractionAt), desc(contacts.createdAt)],
      limit: KNOWLEDGE_PAGE_SIZE,
    });

    for (const c of contactRows) {
      const name = c.preferredName || c.fullName;
      if ((!kindFilter || kindFilter === "summary") && c.aiSummary?.trim()) {
        entries.push({
          id: `summary:${c.id}`,
          kind: "summary",
          contactId: c.id,
          contactName: name,
          company: c.company,
          title: c.title,
          snippet: c.aiSummary.trim().slice(0, 420),
          date: knowledgeDate(c),
          source: c.source,
        });
      }
      if ((!kindFilter || kindFilter === "note") && c.notes?.trim()) {
        entries.push({
          id: `notes:${c.id}`,
          kind: "note",
          contactId: c.id,
          contactName: name,
          company: c.company,
          title: c.title,
          snippet: c.notes.trim().slice(0, 420),
          date: knowledgeDate(c),
          source: "profile_notes",
        });
      }
      if (!kindFilter || kindFilter === "key_fact") {
        for (const fact of c.keyFacts || []) {
          if (!fact.trim()) continue;
          entries.push({
            id: `fact:${c.id}:${fact.slice(0, 40)}`,
            kind: "key_fact",
            contactId: c.id,
            contactName: name,
            company: c.company,
            title: c.title,
            snippet: fact.trim().slice(0, 420),
            date: knowledgeDate(c),
            source: "key_facts",
          });
        }
      }
    }
  }

  entries.sort((a, b) => {
    const da = a.date ? new Date(a.date).getTime() : 0;
    const db_ = b.date ? new Date(b.date).getTime() : 0;
    return db_ - da;
  });

  return {
    stats,
    entries: entries.slice(0, 400),
  };
}
