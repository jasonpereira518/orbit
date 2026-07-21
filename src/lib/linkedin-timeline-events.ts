/**
 * Extract timeline events (meetings, reach-outs, in-person) from LinkedIn
 * message threads during import.
 */

import { z } from "zod";
import { completeJson, parseAiJson } from "@/lib/ai";
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

/**
 * Rule + AI hybrid: always emit initial reach-out; ask the model for meetings
 * and in-person events with date hints resolved against message timestamps.
 */
export async function extractLinkedInTimelineEvents(
  userId: string,
  conversationId: string,
  messages: LinkedInTimelineMessage[]
): Promise<LinkedInTimelineEvent[]> {
  const usable = messages
    .map((m, index) => ({
      ...m,
      index,
      content: m.content.trim(),
      date: m.parsedDate,
    }))
    .filter((m) => m.content.length > 0)
    .slice(0, 80);

  if (usable.length === 0) return [];

  const events: LinkedInTimelineEvent[] = [];

  // Initial reach-out = earliest message in the thread
  const first = [...usable].sort((a, b) => {
    const ta = a.date?.getTime() ?? 0;
    const tb = b.date?.getTime() ?? 0;
    return ta - tb;
  })[0];
  if (first) {
    const when = first.date || new Date();
    events.push({
      interactionType: "reach_out",
      interactionDate: when,
      summary: `Initial LinkedIn reach-out: ${first.content.slice(0, 140)}`,
      rawNotes: first.content,
      externalId: `li-event:${conversationId}:reach_out:${stableHash(first.content.slice(0, 80))}`,
    });
  }

  const transcript = usable
    .map((m) => {
      const when = m.date
        ? m.date.toISOString().slice(0, 10)
        : "unknown-date";
      return `[#${m.index} · ${when} · from:${m.from || "?"}] ${m.content.slice(0, 500)}`;
    })
    .join("\n")
    .slice(0, 14_000);

  try {
    const content = await completeJson(userId, {
      temperature: 0.1,
      system: `You extract relationship timeline events from a LinkedIn DM thread.
Return strict JSON:
{ "events": [ { "type": "meeting"|"in_person"|"reach_out", "summary": string, "dateHint": string|null, "sourceMessageIndex": number } ] }

Rules:
- Only include meetings that were proposed or confirmed, and in-person meetups/events clearly referenced.
- Skip ordinary small talk. Do NOT list every message.
- dateHint should be an explicit or relative date phrase from the message when present (e.g. "next Tuesday", "March 3", "tomorrow").
- sourceMessageIndex must match a [#N] index from the transcript.
- Max 8 events. Prefer precision over volume.
- Do not invent events.`,
      user: `Thread:\n${transcript}`,
    });

    const parsed = eventsSchema.parse(parseAiJson(content));
    for (const ev of parsed.events) {
      if (ev.type === "reach_out") continue; // already added
      const src =
        typeof ev.sourceMessageIndex === "number"
          ? usable.find((m) => m.index === ev.sourceMessageIndex)
          : null;
      const ref = src?.date || first?.date || new Date();
      const fromHint = ev.dateHint
        ? parseInteractionDateFromNotes(ev.dateHint, ref)
        : null;
      const fromBody = src
        ? parseInteractionDateFromNotes(src.content, ref)
        : null;
      const when = fromHint || fromBody || ref;

      events.push({
        interactionType: ev.type,
        interactionDate: when,
        summary: ev.summary.trim().slice(0, 240),
        rawNotes: src?.content || ev.summary,
        externalId: `li-event:${conversationId}:${ev.type}:${stableHash(
          `${ev.summary}:${ev.sourceMessageIndex ?? ""}:${ev.dateHint ?? ""}`
        )}`,
      });
    }
  } catch {
    // Heuristic fallback without AI
    for (const m of usable) {
      const lower = m.content.toLowerCase();
      const looksMeeting =
        /\b(meet|meeting|call|zoom|google meet|calendly|schedule|sync)\b/.test(
          lower
        );
      const looksInPerson =
        /\b(in person|coffee|lunch|dinner|office|campus|conference|meetup)\b/.test(
          lower
        );
      if (!looksMeeting && !looksInPerson) continue;
      const ref = m.date || new Date();
      const when = parseInteractionDateFromNotes(m.content, ref) || ref;
      const type = looksInPerson ? "in_person" : "meeting";
      events.push({
        interactionType: type,
        interactionDate: when,
        summary: m.content.slice(0, 140),
        rawNotes: m.content,
        externalId: `li-event:${conversationId}:${type}:${stableHash(m.content.slice(0, 80))}`,
      });
    }
  }

  // Dedupe by externalId
  const seen = new Set<string>();
  return events.filter((e) => {
    if (seen.has(e.externalId)) return false;
    seen.add(e.externalId);
    return true;
  });
}
