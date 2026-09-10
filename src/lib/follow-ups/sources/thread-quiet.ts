import { daysBetween, startOfDay } from "../time";
import type { SignalCandidate, SignalSource } from "../types";

/**
 * Generalizes the old `linkedin_thread_quiet` to every written channel.
 * Mirrors the `family: "written"` grouping in `src/lib/interaction-types.ts`.
 */
const WRITTEN_TYPES = new Set(["linkedin_message", "email", "message"]);

const MIN_MESSAGES = 2;
const QUIET_MIN_DAYS = 14;
const QUIET_MAX_DAYS = 90;

export const threadQuietSource: SignalSource = {
  kind: "thread_quiet",
  cadence: "daily",
  detect(ctx) {
    const out: SignalCandidate[] = [];
    for (const c of ctx.contacts) {
      const written = (ctx.interactionsByContact.get(c.id) ?? []).filter((i) =>
        WRITTEN_TYPES.has(i.interactionType)
      );
      if (written.length < MIN_MESSAGES) continue;
      // Newest first, so [0] is the last message in the thread.
      const days = daysBetween(written[0].interactionDate, ctx.now);
      // Bounded on both ends: past 90 days it is dormancy, not a stalled thread,
      // and `dormant` says that better.
      if (days === null || days < QUIET_MIN_DAYS || days > QUIET_MAX_DAYS) continue;
      out.push({
        kind: "thread_quiet",
        contactId: c.id,
        dueOn: startOfDay(ctx.now),
        evidence: `A ${written.length}-message thread went quiet ${days} days ago`,
      });
    }
    return out;
  },
};
