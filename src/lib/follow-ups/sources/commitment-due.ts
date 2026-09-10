import { startOfDay } from "../time";
import type { SignalCandidate, SignalSource } from "../types";

/**
 * The highest-prior signal: the user said, in their own notes, that they would do this.
 *
 * Reads CONFIRMED commitments only — `ctx.dueCommitments` is loaded from `reminders`
 * rows whose date has arrived, never from `suggested_reminders`, which are unreviewed
 * extractions.
 */
export const commitmentDueSource: SignalSource = {
  kind: "commitment_due",
  cadence: "daily",
  detect(ctx) {
    const out: SignalCandidate[] = [];
    const known = new Set(ctx.contacts.map((c) => c.id));
    for (const commitment of ctx.dueCommitments) {
      if (!known.has(commitment.contactId)) continue;
      if (commitment.dueDate > ctx.now) continue;
      out.push({
        kind: "commitment_due",
        contactId: commitment.contactId,
        dueOn: startOfDay(ctx.now),
        evidence: `You committed to this: "${commitment.title}"`,
      });
    }
    return out;
  },
};
