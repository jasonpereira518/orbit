import { and, desc, eq, inArray, isNotNull, lte } from "drizzle-orm";
import { getDb } from "@/db";
import { aiSuggestions, contacts } from "@/db/schema";

/**
 * The "who needs attention" half of chat grounding.
 *
 * "Who should I reconnect with this week?" is one of Orbit's own suggested questions and
 * the product's core claim — but semantic retrieval answers it with whichever contacts
 * happen to be near the query vector, which for that phrasing is nobody in particular.
 * The honest-but-useless reply ("I don't have enough details…") lands while the dashboard
 * two clicks away is showing eight overdue follow-ups.
 *
 * So the same two facts the dashboard renders are handed to the model directly: contacts
 * whose follow-up date has passed, and the standing outreach queue. Both are reads of
 * rows the product already computed — nothing here is inferred.
 */
export type AttentionBrief = {
  overdue: Array<{
    id: string;
    name: string;
    title: string | null;
    company: string | null;
    daysOverdue: number;
    daysSinceTouch: number | null;
    hasLoggedInteraction: boolean;
  }>;
  suggestions: Array<{
    id: string;
    name: string;
    title: string | null;
    company: string | null;
    /** e.g. "Gone quiet — last touch 105 days ago". Written by the suggestion builder. */
    reason: string;
  }>;
};

const OVERDUE_CAP = 12;
const SUGGESTION_CAP = 12;
const DAY_MS = 86_400_000;

/**
 * Questions this brief is for. Deliberately narrow: attaching an attention queue to
 * "who do I know at Google?" would push the model toward answering a question nobody
 * asked. Substring matching on purpose — "follow up", "followed up", "follow-ups" all hit.
 */
const ATTENTION_PATTERNS = [
  "reconnect",
  "reach out",
  "follow up",
  "follow-up",
  "followup",
  "followed up",
  "catch up",
  "check in",
  "overdue",
  "gone quiet",
  "quiet",
  "dormant",
  "neglect",
  "lost touch",
  "haven't spoken",
  "havent spoken",
  "haven't talked",
  "not talked",
  "who should i",
  "need attention",
  "this week",
  "cold",
];

export function isAttentionQuestion(question: string) {
  const q = question.toLowerCase();
  return ATTENTION_PATTERNS.some((p) => q.includes(p));
}

function daysBetween(from: Date | string | null, now: number) {
  if (!from) return null;
  const t = new Date(from).getTime();
  if (!Number.isFinite(t)) return null;
  return Math.max(0, Math.round((now - t) / DAY_MS));
}

export async function getAttentionBrief(
  userId: string,
  interactedIds?: Set<string>
): Promise<AttentionBrief> {
  const db = await getDb();
  const now = new Date();
  const nowMs = now.getTime();

  const [overdueRows, suggestionRows] = await Promise.all([
    db.query.contacts.findMany({
      where: and(
        eq(contacts.userId, userId),
        isNotNull(contacts.nextFollowUpAt),
        lte(contacts.nextFollowUpAt, now)
      ),
      columns: {
        id: true,
        fullName: true,
        preferredName: true,
        title: true,
        company: true,
        nextFollowUpAt: true,
        lastInteractionAt: true,
      },
      orderBy: (c, { asc }) => [asc(c.nextFollowUpAt)],
      limit: OVERDUE_CAP,
    }),
    db.query.aiSuggestions.findMany({
      where: and(
        eq(aiSuggestions.userId, userId),
        eq(aiSuggestions.status, "pending")
      ),
      orderBy: [desc(aiSuggestions.confidenceScore)],
      limit: SUGGESTION_CAP,
    }),
  ]);

  const suggestionContactIds = suggestionRows
    .map((s) => s.relatedContactIds?.[0])
    .filter((id): id is string => Boolean(id));

  const suggestionContacts = suggestionContactIds.length
    ? await db.query.contacts.findMany({
        where: and(
          eq(contacts.userId, userId),
          inArray(contacts.id, suggestionContactIds)
        ),
        columns: {
          id: true,
          fullName: true,
          preferredName: true,
          title: true,
          company: true,
        },
      })
    : [];
  const byId = new Map(suggestionContacts.map((c) => [c.id, c]));

  // A contact already listed as overdue does not need a second entry as a suggestion —
  // the dashboard applies the same de-duplication.
  const overdueIds = new Set(overdueRows.map((c) => c.id));

  return {
    overdue: overdueRows.map((c) => ({
      id: c.id,
      name: c.preferredName || c.fullName,
      title: c.title,
      company: c.company,
      daysOverdue: daysBetween(c.nextFollowUpAt, nowMs) ?? 0,
      daysSinceTouch: daysBetween(c.lastInteractionAt, nowMs),
      // Without this the model would report an import stamp as a conversation.
      hasLoggedInteraction: interactedIds ? interactedIds.has(c.id) : false,
    })),
    suggestions: suggestionRows.flatMap((s) => {
      const contactId = s.relatedContactIds?.[0];
      const contact = contactId ? byId.get(contactId) : null;
      if (!contact || overdueIds.has(contact.id)) return [];
      return [
        {
          id: contact.id,
          name: contact.preferredName || contact.fullName,
          title: contact.title,
          company: contact.company,
          reason: (s.description || s.title || "").trim(),
        },
      ];
    }),
  };
}
