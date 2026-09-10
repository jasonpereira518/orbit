import { DORMANT_DAYS } from "../registry";
import { daysBetween, startOfDay } from "../time";
import type { SignalCandidate, SignalSource } from "../types";

export const dormantSource: SignalSource = {
  kind: "dormant",
  cadence: "daily",
  detect(ctx) {
    const out: SignalCandidate[] = [];
    for (const c of ctx.contacts) {
      const threshold = DORMANT_DAYS[c.closenessTier ?? "unknown"];
      const idle = daysBetween(c.lastInteractionAt, ctx.now);
      // Null idle means no interaction ever — that is `never_contacted`, not dormancy.
      if (idle === null || idle < threshold) continue;
      out.push({
        kind: "dormant",
        contactId: c.id,
        dueOn: startOfDay(ctx.now),
        evidence: `No contact in ${idle} days (${c.closenessTier ?? "unclassified"} tier fires at ${threshold})`,
      });
    }
    return out;
  },
};
