import { sameMonthDay, startOfDay } from "../time";
import type { SignalCandidate, SignalSource } from "../types";

export const metAnniversarySource: SignalSource = {
  kind: "met_anniversary",
  cadence: "daily",
  detect(ctx) {
    const out: SignalCandidate[] = [];
    for (const c of ctx.contacts) {
      const anchor = c.dateMet ?? c.firstInteractionAt;
      if (!anchor) continue;
      if (!sameMonthDay(anchor, anchor.getMonth() + 1, anchor.getDate())) continue;
      if (!sameMonthDay(ctx.now, anchor.getMonth() + 1, anchor.getDate())) continue;
      const years = ctx.now.getFullYear() - anchor.getFullYear();
      // Same-year and negative are noise: "you met them 0 years ago today" is just today.
      if (years < 1) continue;
      out.push({
        kind: "met_anniversary",
        contactId: c.id,
        dueOn: startOfDay(ctx.now),
        evidence: `You met ${years} year${years === 1 ? "" : "s"} ago today`,
      });
    }
    return out;
  },
};
