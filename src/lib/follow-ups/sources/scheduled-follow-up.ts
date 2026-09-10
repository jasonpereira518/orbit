import { startOfDay } from "../time";
import type { SignalCandidate, SignalSource } from "../types";

/**
 * A follow-up date the USER chose.
 *
 * This is now the only meaning `contacts.next_follow_up_at` carries. The old
 * `generateDueFollowUps` stamped it speculatively on eight contacts at a time, which
 * made a system guess and a deliberate choice indistinguishable in the column. The
 * engine reads it and never writes it.
 */
export const scheduledFollowUpSource: SignalSource = {
  kind: "scheduled_follow_up",
  cadence: "daily",
  detect(ctx) {
    const out: SignalCandidate[] = [];
    for (const c of ctx.contacts) {
      if (!c.nextFollowUpAt || c.nextFollowUpAt > ctx.now) continue;
      out.push({
        kind: "scheduled_follow_up",
        contactId: c.id,
        dueOn: startOfDay(ctx.now),
        evidence: "You scheduled a follow-up for today or earlier",
      });
    }
    return out;
  },
};
