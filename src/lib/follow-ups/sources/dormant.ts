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
        // User-facing copy: `reasonFor` in `pass.ts` pipes this straight through to the
        // Today card, so it must read as plain language, not engine internals. Closeness
        // tiers and thresholds are implementation vocabulary the product never names
        // anywhere else — say what happened, not why the rule fired.
        evidence: `No contact in ${idle} days`,
      });
    }
    return out;
  },
};
