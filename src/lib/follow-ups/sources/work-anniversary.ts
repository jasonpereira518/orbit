import { startOfDay } from "../time";
import type { SignalCandidate, SignalSource } from "../types";

/**
 * Derived from `contact_experiences`, which stores start month and year but no day.
 * Fires on the first of the start month — the only day the data actually supports.
 */
export const workAnniversarySource: SignalSource = {
  kind: "work_anniversary",
  cadence: "daily",
  detect(ctx) {
    const out: SignalCandidate[] = [];
    for (const c of ctx.contacts) {
      const current = (ctx.experiencesByContact.get(c.id) ?? []).find((e) => e.isCurrent);
      if (!current?.startYear || !current.startMonth) continue;
      if (ctx.now.getMonth() + 1 !== current.startMonth) continue;
      if (ctx.now.getDate() !== 1) continue;
      const years = ctx.now.getFullYear() - current.startYear;
      if (years < 1) continue;
      out.push({
        kind: "work_anniversary",
        contactId: c.id,
        dueOn: startOfDay(ctx.now),
        evidence: `${years} year${years === 1 ? "" : "s"} at ${current.organization} this month`,
      });
    }
    return out;
  },
};
