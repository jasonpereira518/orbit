import { classifyCalendarEvent, counterpartsOf, type EventClassification } from "@/lib/calendar-classify";
import type { ParsedCalendarEvent } from "@/lib/calendar-import";
import { CALENDAR_TUNING, calendarKindQuestion } from "@/lib/decisions/catalog";
import { canAct, decideEach, type Engines } from "@/lib/decisions/engine";

/**
 * Which calendar events are relationship touches.
 *
 * The rules (`classifyCalendarEvent`) decide on title words, attendee count and duration, and
 * their mistakes cost the user: a vendor or doctor appointment with one guest becomes a
 * "1:1" — a new contact, a logged meeting and, on ICS feeds, a follow-up nudge — while
 * "Wedding planning with Sarah" is dropped for the word "planning".
 *
 * With Jev, an event the rules would KEEP is read as a whole, and one that is confidently not
 * a one-to-one or networking touch is skipped. Keeping an event the rules skip is an action
 * (it creates contacts) and ships disabled. Jev only: this runs on every event of every sync,
 * and without Jev the rules decide exactly as before.
 */

export type DecidedEvent = { event: ParsedCalendarEvent; classification: EventClassification; by: "rules" | "decision" };

function domain(email: string | null | undefined) {
  return email?.split("@")[1]?.toLowerCase() || null;
}

export function calendarEventState(event: ParsedCalendarEvent, selfEmails: string[]) {
  const people = counterpartsOf(event, selfEmails);
  const minutes = event.start && event.end ? Math.round((event.end.getTime() - event.start.getTime()) / 60000) : null;
  const domains = [...new Set(people.map((p) => domain(p.email)).filter((d): d is string => Boolean(d)))].slice(0, 5);
  return {
    title: event.summary || "(no title)",
    description: (event.description || "").replace(/mailto:\S+/gi, "").replace(/\s+/g, " ").trim().slice(0, CALENDAR_TUNING.descriptionChars) || null,
    duration_minutes: minutes,
    other_attendees: people.length,
    attendee_domains: domains,
    organizer_domain: domain(event.organizer?.email),
    location: event.location || null,
  };
}

export async function decideCalendarEvents(
  engines: Engines,
  events: readonly ParsedCalendarEvent[],
  selfEmails: string[],
): Promise<{ decided: DecidedEvent[]; skippedByDecision: number; keptByDecision: number }> {
  const decided: DecidedEvent[] = events.map((event) => ({
    event,
    classification: classifyCalendarEvent(event, selfEmails),
    by: "rules",
  }));
  if (!engines.jev) return { decided, skippedByDecision: 0, keptByDecision: 0 };

  // Only what the model could change: every rule "keep" (a veto is always allowed), and
  // rule "skip"s with people on them only when keeping is enabled at all.
  const actAbove = CALENDAR_TUNING.act;
  const asked = decided
    .map((d, i) => ({ d, i }))
    .filter(({ d }) => {
      if (!d.event.start) return false;
      // Kept on a person's name in the title alone (an ICS feed with no guests and no
      // description): there is nothing more for the model to read, and the eval showed it
      // vetoing exactly those real 1:1s. The rules' call stands.
      if (d.classification.keep) return !/^Title names a person/.test(d.classification.reason);
      return actAbove !== null && d.classification.counterpartCount > 0 && !/declined|cancelled|invite/i.test(d.classification.reason);
    });
  if (asked.length === 0) return { decided, skippedByDecision: 0, keptByDecision: 0 };

  const answers = await decideEach(
    { jev: engines.jev, llm: null },
    { engines: ["jev"], budgetMs: CALENDAR_TUNING.budgetMs, cacheDays: CALENDAR_TUNING.cacheDays },
    {
      operation: "calendar.kind",
      items: asked.map(({ d }) => calendarEventState(d.event, selfEmails)),
      chunkSize: CALENDAR_TUNING.chunkSize,
      concurrency: CALENDAR_TUNING.concurrency,
      state: (chunk) => ({ events: Object.fromEntries(chunk.map(({ key, item }) => [key, item])) }),
      question: (key) => ({ ...calendarKindQuestion, instructions: `What kind of calendar entry is \`events.${key}\`?` }),
    },
  );

  let skippedByDecision = 0;
  let keptByDecision = 0;
  asked.forEach(({ d, i }, j) => {
    const a = answers[j];
    if (!a || a.engine !== "jev") return;
    const p = a.answer.probabilities;
    const touch = (p.one_on_one ?? 0) + (p.networking ?? 0);
    if (d.classification.keep && touch <= CALENDAR_TUNING.skipAtOrBelow) {
      decided[i] = {
        event: d.event,
        classification: { ...d.classification, keep: false, kind: "skip", reason: `Not a relationship touch (decision model: ${a.answer.choice})` },
        by: "decision",
      };
      skippedByDecision += 1;
    } else if (!d.classification.keep && canAct("jev", touch, actAbove)) {
      const oneOnOne = (p.one_on_one ?? 0) >= (p.networking ?? 0);
      decided[i] = {
        event: d.event,
        classification: {
          ...d.classification,
          keep: true,
          kind: oneOnOne ? "one_on_one" : "networking",
          reason: `A relationship touch (decision model: ${touch.toFixed(2)})`,
        },
        by: "decision",
      };
      keptByDecision += 1;
    }
  });
  return { decided, skippedByDecision, keptByDecision };
}
