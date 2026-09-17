/**
 * Noticing that someone moved.
 *
 * A job change is the single best moment to reach out: congratulations are welcome, the
 * reply rate is high, and the window is narrow. Orbit had no idea when one happened.
 * `contacts.company` and `.title` are overwritten in place — by the Apollo/LinkedIn refresh,
 * by imports, by the user editing the row — so the previous employer was simply gone, and
 * "just joined Stripe" looked exactly like "has been at Stripe for six years".
 *
 * Pure: no database. `updateContactForUser` calls `detectJobChange` with the before and
 * after values and records what comes back.
 */
import { normalizeCompanyKey } from "@/lib/company-name";

/** How long a move stays worth mentioning. */
export const JOB_CHANGE_FRESH_DAYS = 45;

export type JobFields = {
  company?: string | null;
  title?: string | null;
};

export type JobChange = {
  previousCompany: string | null;
  newCompany: string | null;
  previousTitle: string | null;
  newTitle: string | null;
  /** True when the employer changed, as opposed to a promotion at the same one. */
  changedCompany: boolean;
};

function clean(value: string | null | undefined): string | null {
  const trimmed = typeof value === "string" ? value.trim() : "";
  return trimmed ? trimmed : null;
}

/**
 * Trailing legal forms, stripped before comparing employers.
 *
 * `normalizeCompanyKey` deliberately does not do this — it is the key other features match
 * on, and collapsing "Stripe" into "Stripe, Inc." there would change who counts as a
 * colleague across the whole app. Here the stakes are different and one-directional: two
 * sources spelling the same employer differently ("Stripe" from a LinkedIn import, "Stripe,
 * Inc." from Apollo) would otherwise announce a job change that never happened, and a queue
 * that congratulates people on not moving is one the user stops believing. So the looser
 * comparison lives here, where a false negative merely misses a suffix-only rename.
 */
const LEGAL_SUFFIXES = new Set([
  "inc", "llc", "ltd", "limited", "corp", "corporation", "co", "company",
  "plc", "gmbh", "bv", "nv", "ag", "sa", "sas", "srl", "spa", "pty", "pte",
  "oy", "ab", "as", "kk", "llp", "lp",
]);

function companyKey(value: string): string {
  const parts = normalizeCompanyKey(value).split(" ").filter(Boolean);
  while (parts.length > 1 && LEGAL_SUFFIXES.has(parts[parts.length - 1])) {
    parts.pop();
  }
  return parts.join(" ");
}

/** Same employer written differently — "Stripe" and "Stripe, Inc." are not a move. */
function sameCompany(a: string | null, b: string | null): boolean {
  if (a === null || b === null) return a === b;
  return companyKey(a) === companyKey(b);
}

/** Titles get no normalizer beyond case and whitespace; there is no reliable one. */
function sameTitle(a: string | null, b: string | null): boolean {
  if (a === null || b === null) return a === b;
  return a.toLowerCase().replace(/\s+/g, " ") === b.toLowerCase().replace(/\s+/g, " ");
}

/**
 * What changed, or null if nothing did that counts.
 *
 * The rule that matters: a transition FROM nothing is not a job change. Learning someone's
 * employer for the first time is Orbit finding out, not the contact moving, and an
 * enrichment pass over a network of imported LinkedIn connections would otherwise announce
 * a few hundred "new jobs" in one afternoon — every one of them wrong, and all of them in a
 * queue the user would then stop trusting.
 *
 * A transition TO nothing is not one either: enrichment returning no company means it did
 * not find one, never that the person is unemployed. Those are dropped rather than recorded
 * as a move to nowhere.
 */
export function detectJobChange(before: JobFields, after: JobFields): JobChange | null {
  const prevCompany = clean(before.company);
  const prevTitle = clean(before.title);
  // `undefined` means the patch did not carry the field, so the old value stands.
  const nextCompany = after.company === undefined ? prevCompany : clean(after.company);
  const nextTitle = after.title === undefined ? prevTitle : clean(after.title);

  const companyMoved =
    prevCompany !== null && nextCompany !== null && !sameCompany(prevCompany, nextCompany);
  const titleMoved =
    prevTitle !== null && nextTitle !== null && !sameTitle(prevTitle, nextTitle);

  if (!companyMoved && !titleMoved) return null;

  return {
    previousCompany: prevCompany,
    newCompany: nextCompany,
    previousTitle: prevTitle,
    newTitle: nextTitle,
    changedCompany: companyMoved,
  };
}

/**
 * The line shown in the outreach queue.
 *
 * Says where they went and where from, because "congratulate Sarah on the new role" with no
 * detail is a message the user cannot write from. A promotion at the same employer gets
 * different wording: telling someone they "joined" a company they have worked at for years
 * is worse than saying nothing.
 */
export function describeJobChange(change: {
  previousCompany: string | null;
  newCompany: string | null;
  previousTitle: string | null;
  newTitle: string | null;
}): string {
  const companyMoved = !sameCompany(clean(change.previousCompany), clean(change.newCompany));
  const newTitle = clean(change.newTitle);
  const newCompany = clean(change.newCompany);
  const prevCompany = clean(change.previousCompany);

  if (companyMoved && newCompany) {
    const role = newTitle ? `${newTitle} at ${newCompany}` : newCompany;
    return prevCompany ? `Moved to ${role} — was at ${prevCompany}` : `Moved to ${role}`;
  }

  const prevTitle = clean(change.previousTitle);
  const where = newCompany ? ` at ${newCompany}` : "";
  if (newTitle && prevTitle) return `New title${where}: ${prevTitle} → ${newTitle}`;
  if (newTitle) return `New title${where}: ${newTitle}`;
  return `Role changed${where}`;
}
