import { daysBetween, startOfDay } from "../time";
import type { SignalCandidate, SignalSource } from "../types";

/** Long enough that saving someone and messaging them the same week is not nagged. */
const GRACE_DAYS = 14;

export const neverContactedSource: SignalSource = {
  kind: "never_contacted",
  cadence: "daily",
  detect(ctx) {
    const out: SignalCandidate[] = [];
    for (const c of ctx.contacts) {
      if (c.lastInteractionAt) continue;
      if ((ctx.interactionsByContact.get(c.id) ?? []).length > 0) continue;
      const age = daysBetween(c.dateMet, ctx.now);
      if (age === null || age < GRACE_DAYS) continue;
      out.push({
        kind: "never_contacted",
        contactId: c.id,
        dueOn: startOfDay(ctx.now),
        evidence: `Saved ${age} days ago, never contacted`,
      });
    }
    return out;
  },
};
