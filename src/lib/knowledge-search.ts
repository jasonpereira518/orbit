import { and, desc, eq, inArray, or, sql, type SQL } from "drizzle-orm";
import { getDb, rowsOf } from "@/db";
import { contacts } from "@/db/schema";
import { sharedAvatarUrlSql } from "@/lib/contact-avatar-sql";
import {
  KNOWLEDGE_SEARCH_LIMIT,
  KNOWLEDGE_SEARCH_MAX_CHARS,
  KNOWLEDGE_SEARCH_MIN_CHARS,
  type KnowledgeSearchHit,
} from "@/lib/knowledge-people-types";
import { timelineKindOf } from "@/lib/knowledge-timeline-types";

/** Characters of context kept before a match, and the length of the snippet around it. */
const LEAD = 40;
const SNIPPET = 160;
/** Interaction matches read before they are folded into people. Many hits are one person. */
const INTERACTION_SCAN = 150;

const INTERACTION_WHERE = {
  message: "In a message",
  note: "In a note",
  meeting: "In a meeting",
} as const;

/** `needle` is already lowercased. A stretch of `text` around its first match. */
function around(text: SQL, needle: string): SQL {
  return sql`substr(${text}, greatest(strpos(lower(${text}), ${needle}) - ${LEAD}, 1), ${SNIPPET})`;
}

function has(text: SQL, needle: string): SQL {
  return sql`strpos(lower(${text}), ${needle}) > 0`;
}

/**
 * Who has this word in their notes, messages or facts.
 *
 * This is what the old Overview feed's search was for, kept as a lookup on the people list:
 * the list only filters the 300 people it loaded, and only on their name, role and summary
 * line, so "who did I talk to about fintech" found nobody. This reaches everything.
 *
 * The match is `strpos(lower(text), lower(q))`, a literal case-insensitive substring, not a
 * LIKE pattern. A search for `50%` or `a_b` therefore means exactly that, with no wildcards to
 * escape and none to forget. Every statement is scoped by `user_id`, text is cut to a snippet
 * in SQL, and the snippet is raw user text for the caller to render as plain text.
 */
export async function searchKnowledgeContent(
  userId: string,
  query: string
): Promise<KnowledgeSearchHit[]> {
  const q = query.trim().slice(0, KNOWLEDGE_SEARCH_MAX_CHARS);
  if (q.length < KNOWLEDGE_SEARCH_MIN_CHARS) return [];
  const needle = q.toLowerCase();
  const db = await getDb();

  const keyFactsText = sql`translate(${contacts.keyFacts}::text, '[]"', '')`;
  const notesText = sql`${contacts.notes}::text`;
  const summaryText = sql`${contacts.aiSummary}::text`;
  const identityText = sql`concat_ws(' ', ${contacts.fullName}, ${contacts.title}, ${contacts.company})`;
  const personColumns = {
    id: contacts.id,
    fullName: contacts.fullName,
    firstName: contacts.firstName,
    title: contacts.title,
    company: contacts.company,
    lastInteractionAt: contacts.lastInteractionAt,
    hasPhoto: sql<boolean>`((${contacts.profileImageUrl} IS NOT NULL AND ${contacts.profileImageUrl} <> '') OR ${sharedAvatarUrlSql} IS NOT NULL)`,
  };

  const [interactionRows, fieldRows] = await Promise.all([
    db.execute(sql`
      SELECT contact_id, interaction_type, ${around(sql`t`, needle)} AS snippet
        FROM (
          SELECT contact_id, interaction_type, interaction_date,
                 CASE WHEN ${has(sql`coalesce(ai_summary, '')`, needle)} THEN ai_summary ELSE raw_notes END AS t
            FROM interactions
           WHERE user_id = ${userId}
             AND (${has(sql`coalesce(ai_summary, '')`, needle)} OR ${has(sql`coalesce(raw_notes, '')`, needle)})
           ORDER BY interaction_date DESC
           LIMIT ${INTERACTION_SCAN}
        ) m
       ORDER BY interaction_date DESC
    `),
    db
      .select({
        ...personColumns,
        factsSnippet: sql<string | null>`CASE WHEN ${has(keyFactsText, needle)} THEN ${around(keyFactsText, needle)} END`,
        notesSnippet: sql<string | null>`CASE WHEN ${has(notesText, needle)} THEN ${around(notesText, needle)} END`,
        summarySnippet: sql<string | null>`CASE WHEN ${has(summaryText, needle)} THEN ${around(summaryText, needle)} END`,
      })
      .from(contacts)
      .where(
        and(
          eq(contacts.userId, userId),
          or(
            has(keyFactsText, needle),
            has(notesText, needle),
            has(summaryText, needle),
            has(identityText, needle)
          )
        )
      )
      .orderBy(desc(contacts.updatedAt))
      .limit(KNOWLEDGE_SEARCH_LIMIT),
  ]);

  const interactionHits = rowsOf<{
    contact_id: string;
    interaction_type: string | null;
    snippet: string | null;
  }>(interactionRows);

  // People an interaction matched that the field search did not: one read for their rows.
  const known = new Set(fieldRows.map((r) => r.id));
  const missing = [...new Set(interactionHits.map((h) => String(h.contact_id)))].filter((id) => !known.has(id));
  const extra = missing.length
    ? await db
        .select(personColumns)
        .from(contacts)
        .where(and(eq(contacts.userId, userId), inArray(contacts.id, missing.slice(0, KNOWLEDGE_SEARCH_LIMIT * 2))))
    : [];
  const people = new Map([...fieldRows, ...extra].map((p) => [p.id, p]));

  const hits: KnowledgeSearchHit[] = [];
  const seen = new Set<string>();
  const push = (id: string, snippet: string | null, where: string | null) => {
    const p = people.get(id);
    if (!p || seen.has(id) || hits.length >= KNOWLEDGE_SEARCH_LIMIT) return;
    seen.add(id);
    hits.push({
      id: p.id,
      fullName: p.fullName,
      firstName: p.firstName,
      title: p.title,
      company: p.company,
      hasPhoto: Boolean(p.hasPhoto),
      lastInteractionAt: p.lastInteractionAt ? new Date(p.lastInteractionAt).toISOString() : null,
      snippet: snippet?.replace(/\s+/g, " ").trim() || null,
      where: snippet ? where : null,
    });
  };

  // Newest conversation first, then the people whose own profile mentions it.
  for (const h of interactionHits) {
    push(String(h.contact_id), h.snippet, INTERACTION_WHERE[timelineKindOf(h.interaction_type)]);
  }
  for (const r of fieldRows) {
    if (r.factsSnippet) push(r.id, r.factsSnippet, "In their key facts");
    else if (r.notesSnippet) push(r.id, r.notesSnippet, "In your notes");
    else if (r.summarySnippet) push(r.id, r.summarySnippet, "In their summary");
    else push(r.id, null, null);
  }
  return hits;
}
