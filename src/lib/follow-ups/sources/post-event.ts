import { daysBetween, startOfDay } from "../time";
import type { SignalCandidate, SignalSource } from "../types";

/** The window where a new introduction is still warm but no longer same-week. */
const INTRO_MIN_DAYS = 7;
const INTRO_MAX_DAYS = 21;
const EVENT_MIN_DAYS = 2;
const EVENT_MAX_DAYS = 21;

export const postEventSource: SignalSource = {
  kind: "post_event",
  cadence: "daily",
  detect(ctx) {
    const out: SignalCandidate[] = [];
    const seen = new Set<string>();

    // Trigger A — a recent first meeting with nothing since.
    for (const c of ctx.contacts) {
      if (!c.firstInteractionAt) continue;
      const days = daysBetween(c.firstInteractionAt, ctx.now);
      if (days === null || days < INTRO_MIN_DAYS || days > INTRO_MAX_DAYS) continue;
      // Anything after the first interaction means the follow-up already happened.
      if (
        c.lastInteractionAt &&
        c.lastInteractionAt.getTime() !== c.firstInteractionAt.getTime()
      ) {
        continue;
      }
      seen.add(c.id);
      out.push({
        kind: "post_event",
        contactId: c.id,
        dueOn: startOfDay(ctx.now),
        evidence: `You first met ${days} days ago and nothing has been logged since`,
      });
    }

    // Trigger B — shared event attendance. New in this design; the old heuristic
    // had no access to the events tables.
    for (const [contactId, attended] of ctx.eventsByContact) {
      if (seen.has(contactId)) continue;
      for (const event of attended) {
        const days = daysBetween(event.startsAt, ctx.now);
        if (days === null || days < EVENT_MIN_DAYS || days > EVENT_MAX_DAYS) continue;
        const last = daysBetween(
          ctx.contacts.find((c) => c.id === contactId)?.lastInteractionAt ?? null,
          ctx.now
        );
        // Already spoken since the event — nothing to prompt.
        if (last !== null && last < days) break;
        seen.add(contactId);
        out.push({
          kind: "post_event",
          contactId,
          dueOn: startOfDay(ctx.now),
          evidence: `You were both at ${event.title} ${days} days ago`,
        });
        break;
      }
    }

    return out;
  },
};
