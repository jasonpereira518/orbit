import { and, desc, eq, inArray } from "drizzle-orm";
import { getDb } from "@/db";
import { contacts, interactions } from "@/db/schema";
import { sanitizeProfileLine } from "@/lib/contact-profile-format";
import { interactionTypeLabel } from "@/lib/interaction-types";
import { isoDay } from "@/lib/suggested-reminder-utils";

/**
 * People the user attached to a question with the composer's `+`.
 *
 * This is a different claim from retrieval. Retrieval guesses who the question is about;
 * an attachment is the user saying so outright, so these people are pinned into the model's
 * context whether or not search would have found them, and they get a real timeline rather
 * than the one-line-per-contact treatment the ranked list can afford.
 *
 * Rendering is split from loading so a smoke test can exercise the prompt text — including
 * what a hostile note does to it — without a database.
 */

/** Attaching the whole address book is not a question; it is a dump. */
export const ATTACHED_LIMIT = 5;
/** Enough to see a relationship's shape without crowding out everything retrieved. */
export const TIMELINE_LIMIT = 12;
/** A hard ceiling on the block as a whole, independent of the per-field limits. */
export const ATTACHED_MAX_CHARS = 9_000;

export type AttachedTimelineEntry = {
  dateIso: string;
  /** House vocabulary — "Coffee", "1:1 Meeting" — not the raw column value. */
  label: string;
  line: string;
};

export type AttachedPerson = {
  id: string;
  name: string;
  title: string | null;
  company: string | null;
  location: string | null;
  relationshipScore: number;
  keyFacts: string[];
  aiSummary: string | null;
  notes: string | null;
  firstInteractionAt: string | null;
  lastInteractionAt: string | null;
  nextFollowUpAt: string | null;
  totalInteractions: number;
  timeline: AttachedTimelineEntry[];
};

/** One line per interaction: the summary if there is one, else the first line of the note. */
function timelineLine(aiSummary: string | null, rawNotes: string | null): string {
  const text = (aiSummary || rawNotes || "").trim();
  if (!text) return "";
  const first = text.split(/\n/)[0]?.trim() || text;
  return first.length > 220 ? `${first.slice(0, 217)}…` : first;
}

/**
 * The attached contacts and their recent history, in the order the user attached them.
 *
 * Two queries regardless of how many people are attached — the interaction rows come back
 * in one pass and are bucketed here. Unknown ids (someone deleted between attaching and
 * sending) are dropped silently rather than failing the whole question.
 */
export async function loadAttachedPeople(
  userId: string,
  contactIds: readonly string[],
): Promise<AttachedPerson[]> {
  const ids = [...new Set(contactIds.map((id) => id.trim()).filter(Boolean))].slice(
    0,
    ATTACHED_LIMIT,
  );
  if (!ids.length) return [];

  const db = await getDb();
  const [rows, history] = await Promise.all([
    db.query.contacts.findMany({
      where: and(eq(contacts.userId, userId), inArray(contacts.id, ids)),
    }),
    db.query.interactions.findMany({
      where: and(eq(interactions.userId, userId), inArray(interactions.contactId, ids)),
      orderBy: [desc(interactions.interactionDate), desc(interactions.sameDayOrder)],
      // Bounded by the number of people, not by the size of any one history.
      limit: ids.length * (TIMELINE_LIMIT + 8),
    }),
  ]);

  const byContact = new Map<string, AttachedTimelineEntry[]>();
  const counts = new Map<string, number>();
  for (const row of history) {
    counts.set(row.contactId, (counts.get(row.contactId) ?? 0) + 1);
    const list = byContact.get(row.contactId) ?? [];
    if (list.length >= TIMELINE_LIMIT) continue;
    const line = timelineLine(row.aiSummary, row.rawNotes);
    if (!line) continue;
    list.push({
      dateIso: isoDay(new Date(row.interactionDate)),
      label: interactionTypeLabel(row.interactionType),
      line,
    });
    byContact.set(row.contactId, list);
  }

  const byId = new Map(rows.map((r) => [r.id, r]));
  return ids
    .map((id) => byId.get(id))
    .filter((c): c is NonNullable<typeof c> => Boolean(c))
    .map((c) => ({
      id: c.id,
      name: c.preferredName?.trim() || c.fullName,
      title: c.title,
      company: c.company,
      location: c.location,
      relationshipScore: c.relationshipScore,
      keyFacts: c.keyFacts || [],
      aiSummary: c.aiSummary,
      notes: c.notes,
      firstInteractionAt: c.firstInteractionAt ? isoDay(c.firstInteractionAt) : null,
      lastInteractionAt: c.lastInteractionAt ? isoDay(c.lastInteractionAt) : null,
      nextFollowUpAt: c.nextFollowUpAt ? isoDay(c.nextFollowUpAt) : null,
      totalInteractions: counts.get(c.id) ?? 0,
      timeline: byContact.get(c.id) ?? [],
    }));
}

/**
 * The attached people as prompt text — who they are, then what has happened, oldest last.
 *
 * Every value here is user- or profile-authored and reaches a model prompt, so each one
 * goes through `sanitizeProfileLine` for the same reason the retrieved rows do: a note
 * containing a newline could otherwise open a row of its own inside the block. The block's
 * outer fence (in `buildChatPrompt`) is what stops the block itself being escaped.
 */
export function renderAttachedPeople(people: readonly AttachedPerson[]): string | null {
  if (!people.length) return null;

  const blocks = people.map((p) => {
    const lines: string[] = [];
    const role = [p.title, p.company]
      .filter((v): v is string => Boolean(v?.trim()))
      .map(sanitizeProfileLine)
      .join(" @ ");
    lines.push(`[id=${p.id}] ${sanitizeProfileLine(p.name)}${role ? ` — ${role}` : ""}`);

    const facts: string[] = [];
    if (p.location) facts.push(`Based in ${sanitizeProfileLine(p.location)}`);
    facts.push(`closeness ${p.relationshipScore}/5`);
    if (p.totalInteractions) {
      facts.push(
        `${p.totalInteractions} logged interaction${p.totalInteractions === 1 ? "" : "s"}`,
      );
    }
    if (p.firstInteractionAt) facts.push(`first ${p.firstInteractionAt}`);
    if (p.lastInteractionAt) facts.push(`last ${p.lastInteractionAt}`);
    if (p.nextFollowUpAt) facts.push(`follow-up due ${p.nextFollowUpAt}`);
    lines.push(facts.join(" · "));

    if (p.aiSummary?.trim()) lines.push(`Summary: ${sanitizeProfileLine(p.aiSummary)}`);
    if (p.notes?.trim()) {
      lines.push(`Notes: ${sanitizeProfileLine(p.notes).slice(0, 1200)}`);
    }
    if (p.keyFacts.length) {
      lines.push(`Key facts: ${p.keyFacts.slice(0, 8).map(sanitizeProfileLine).join("; ")}`);
    }

    if (p.timeline.length) {
      lines.push(`Timeline (most recent first, ${p.timeline.length} shown):`);
      for (const entry of p.timeline) {
        lines.push(`- ${entry.dateIso} · ${entry.label}: ${sanitizeProfileLine(entry.line)}`);
      }
    } else {
      lines.push("Timeline: nothing logged yet.");
    }
    return lines.join("\n");
  });

  const rendered = blocks.join("\n\n");
  if (rendered.length <= ATTACHED_MAX_CHARS) return rendered;
  return `${rendered.slice(0, ATTACHED_MAX_CHARS)}\n(attached context truncated at ${ATTACHED_MAX_CHARS} characters)`;
}
