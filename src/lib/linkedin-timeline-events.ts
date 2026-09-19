/**
 * Extract timeline events (meetings, reach-outs, in-person) from LinkedIn
 * message threads during import.
 */

import { z } from "zod";
import { completeJson, parseAiJson } from "@/lib/ai";
import { qualifiesForTimelineAi } from "@/lib/timeline-cost";
import { parseInteractionDateFromNotes } from "@/lib/interaction-date";

export type LinkedInTimelineMessage = {
  from?: string | null;
  content: string;
  parsedDate: Date | null;
};

export type LinkedInTimelineEvent = {
  interactionType: "reach_out" | "meeting" | "in_person";
  interactionDate: Date;
  summary: string;
  rawNotes: string;
  externalId: string;
};

const eventsSchema = z.object({
  events: z.array(
    z.object({
      type: z.enum(["reach_out", "meeting", "in_person"]),
      summary: z.string().min(1),
      dateHint: z.string().nullable().optional(),
      sourceMessageIndex: z.number().int().nonnegative().optional(),
    })
  ),
});

function stableHash(input: string) {
  let h = 0;
  for (let i = 0; i < input.length; i++) {
    h = (h * 31 + input.charCodeAt(i)) | 0;
  }
  return Math.abs(h).toString(36);
}

type UsableMessage = LinkedInTimelineMessage & { index: number; content: string; date: Date | null };

const TIMELINE_SYSTEM = `You extract relationship timeline events from a LinkedIn DM thread.
Return strict JSON:
{ "events": [ { "type": "meeting"|"in_person"|"reach_out", "summary": string, "dateHint": string|null, "sourceMessageIndex": number } ] }

Rules:
- Only include meetings that were proposed or confirmed, and in-person meetups/events clearly referenced.
- Skip ordinary small talk. Do NOT list every message.
- dateHint should be an explicit or relative date phrase from the message when present (e.g. "next Tuesday", "March 3", "tomorrow").
- sourceMessageIndex must match a [#N] index from the transcript.
- Max 8 events. Prefer precision over volume.
- Do not invent events.`;

/**
 * What the extractor knows before any model call: the messages worth reading, the
 * rule-based reach-out event (which needs no model), and the prompt — null when the thread
 * does not qualify for one. Split out so the batched path can submit the prompt now and
 * turn the answer into events later, from exactly the same inputs.
 */
export function prepareTimelineExtraction(
  scopeId: string,
  messages: LinkedInTimelineMessage[]
): { usable: UsableMessage[]; baseEvents: LinkedInTimelineEvent[]; prompt: { system: string; user: string } | null } {
  const usable: UsableMessage[] = messages
    .map((m, index) => ({ ...m, index, content: m.content.trim(), date: m.parsedDate }))
    .filter((m) => m.content.length > 0)
    .slice(0, 80);

  if (usable.length === 0) return { usable, baseEvents: [], prompt: null };

  const baseEvents: LinkedInTimelineEvent[] = [];
  // Initial reach-out = earliest message in the thread
  const first = [...usable].sort((a, b) => (a.date?.getTime() ?? 0) - (b.date?.getTime() ?? 0))[0];
  if (first) {
    baseEvents.push({
      interactionType: "reach_out",
      interactionDate: first.date || new Date(),
      summary: `Initial LinkedIn reach-out: ${first.content.slice(0, 140)}`,
      rawNotes: first.content,
      externalId: `li-event:${scopeId}:reach_out:${stableHash(first.content.slice(0, 80))}`,
    });
  }

  // A single message is a reach-out and nothing else — there is no reply in which a
  // meeting could have been proposed. Skipping the model here is most threads in an
  // export, at no loss (audit A6).
  if (!qualifiesForTimelineAi(usable.length)) return { usable, baseEvents, prompt: null };

  const transcript = usable
    .map((m) => {
      const when = m.date ? m.date.toISOString().slice(0, 10) : "unknown-date";
      return `[#${m.index} · ${when} · from:${m.from || "?"}] ${m.content.slice(0, 500)}`;
    })
    .join("\n")
    .slice(0, 14_000);

  return { usable, baseEvents, prompt: { system: TIMELINE_SYSTEM, user: `Thread:\n${transcript}` } };
}

/** The model's answer as events. Throws when the answer is not the shape it promised. */
export function timelineEventsFromAnswer(
  scopeId: string,
  usable: UsableMessage[],
  content: string
): LinkedInTimelineEvent[] {
  const parsed = eventsSchema.parse(parseAiJson(content));
  const first = [...usable].sort((a, b) => (a.date?.getTime() ?? 0) - (b.date?.getTime() ?? 0))[0];
  const events: LinkedInTimelineEvent[] = [];
  for (const ev of parsed.events) {
    if (ev.type === "reach_out") continue; // already added by prepare
    const src = typeof ev.sourceMessageIndex === "number" ? usable.find((m) => m.index === ev.sourceMessageIndex) : null;
    const ref = src?.date || first?.date || new Date();
    const fromHint = ev.dateHint ? parseInteractionDateFromNotes(ev.dateHint, ref) : null;
    const fromBody = src ? parseInteractionDateFromNotes(src.content, ref) : null;
    const when = fromHint || fromBody || ref;
    events.push({
      interactionType: ev.type,
      interactionDate: when,
      summary: ev.summary.trim().slice(0, 240),
      rawNotes: src?.content || ev.summary,
      externalId: `li-event:${scopeId}:${ev.type}:${stableHash(`${ev.summary}:${ev.sourceMessageIndex ?? ""}:${ev.dateHint ?? ""}`)}`,
    });
  }
  return events;
}

/** What a thread yields with no model at all: keyword-matched meetings and meetups. */
export function heuristicTimelineEvents(scopeId: string, usable: UsableMessage[]): LinkedInTimelineEvent[] {
  const events: LinkedInTimelineEvent[] = [];
  for (const m of usable) {
    const lower = m.content.toLowerCase();
    const looksMeeting = /\b(meet|meeting|call|zoom|google meet|calendly|schedule|sync)\b/.test(lower);
    const looksInPerson = /\b(in person|coffee|lunch|dinner|office|campus|conference|meetup)\b/.test(lower);
    if (!looksMeeting && !looksInPerson) continue;
    const ref = m.date || new Date();
    const when = parseInteractionDateFromNotes(m.content, ref) || ref;
    const type = looksInPerson ? "in_person" : "meeting";
    events.push({
      interactionType: type,
      interactionDate: when,
      summary: m.content.slice(0, 140),
      rawNotes: m.content,
      externalId: `li-event:${scopeId}:${type}:${stableHash(m.content.slice(0, 80))}`,
    });
  }
  return events;
}

/** Drops events that would collide on their externalId. */
export function dedupeTimelineEvents(events: LinkedInTimelineEvent[]): LinkedInTimelineEvent[] {
  const seen = new Set<string>();
  return events.filter((e) => {
    if (seen.has(e.externalId)) return false;
    seen.add(e.externalId);
    return true;
  });
}

/**
 * Rule + AI hybrid: always emit initial reach-out; ask the model for meetings
 * and in-person events with date hints resolved against message timestamps.
 *
 * `scopeId` is only ever used to prefix the `externalId`s this mints — it names the thing
 * the events belong to, and it is what makes them stable across re-derivation and unique
 * against each other on `interactions`' `(user_id, external_id)` index. It was a
 * conversation id when the pre-engine importer called this with the parsed CSV still in
 * memory; its one caller today (`src/lib/linkedin-timeline-backfill.ts`) reads messages
 * back from the database, where conversation groupings no longer exist, and passes a
 * *contact* id instead. Renamed rather than left as `conversationId` because that
 * difference is deliberate and load-bearing: the two namespaces not colliding is precisely
 * what keeps the backfill from re-deriving events for threads the old importer already
 * processed. See that file's header.
 */
export async function extractLinkedInTimelineEvents(
  userId: string,
  scopeId: string,
  messages: LinkedInTimelineMessage[]
): Promise<LinkedInTimelineEvent[]> {
  const { usable, baseEvents, prompt } = prepareTimelineExtraction(scopeId, messages);
  if (usable.length === 0) return [];
  if (!prompt) return dedupeTimelineEvents(baseEvents);

  try {
    const content = await completeJson(userId, {
      operation: "import.linkedin.timeline",
      // The fast tier (FAST_MODELS in ai.ts), not the user's chat model: extraction of at
      // most eight short events does not need it, and this runs once per conversation.
      speed: "fast",
      temperature: 0.1,
      system: prompt.system,
      user: prompt.user,
    });
    return dedupeTimelineEvents([...baseEvents, ...timelineEventsFromAnswer(scopeId, usable, content)]);
  } catch {
    // Heuristic fallback without AI
    return dedupeTimelineEvents([...baseEvents, ...heuristicTimelineEvents(scopeId, usable)]);
  }
}
