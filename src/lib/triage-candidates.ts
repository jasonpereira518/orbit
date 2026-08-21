import { EVIDENCE_FLOOR } from "@/lib/closeness-evidence";

export type TriageCandidate = {
  id: string;
  fullName: string;
  company: string | null;
  evidence: number;
  prior: number;
  statedCloseness: number | null;
};

/** Roughly five screens of eight. */
export const TRIAGE_LIMIT = 40;

/** Shares of the shortlist drawn from each pool. */
const POOL_SHARES = { highEvidence: 0.35, highPrior: 0.45, diversity: 0.2 } as const;

/**
 * Choose who to ask about.
 *
 * Deliberately NOT "the current top 40 by closeness". That list is dominated by
 * whoever a connected source happened to cover, so asking about them confirms
 * what Orbit already knows and learns nothing. The shortlist is built for
 * information gain instead:
 *
 *   1. High evidence, unrated — calibrates the scale against people whose
 *      behaviour we can already see.
 *   2. High prior, no evidence — maximum uncertainty. These are the ones the
 *      system genuinely cannot guess, so an answer moves them furthest.
 *   3. A diversity sample across employers, so the shortlist does not collapse
 *      onto whichever company dominates the orbit.
 */
export function selectTriageCandidates(
  contacts: TriageCandidate[],
  limit: number = TRIAGE_LIMIT
): TriageCandidate[] {
  // Asking twice wastes the user's only scarce resource here: patience.
  const eligible = contacts.filter((c) => c.statedCloseness == null);

  const picked: TriageCandidate[] = [];
  const taken = new Set<string>();

  const take = (pool: TriageCandidate[], count: number) => {
    for (const c of pool) {
      if (picked.length >= limit || count <= 0) break;
      if (taken.has(c.id)) continue;
      taken.add(c.id);
      picked.push(c);
      count--;
    }
  };

  const highEvidence = eligible
    .filter((c) => c.evidence >= EVIDENCE_FLOOR)
    .sort((a, b) => b.evidence - a.evidence);

  const highPrior = eligible
    .filter((c) => c.evidence < EVIDENCE_FLOOR)
    .sort((a, b) => b.prior - a.prior);

  take(highEvidence, Math.round(limit * POOL_SHARES.highEvidence));
  take(highPrior, Math.round(limit * POOL_SHARES.highPrior));

  // Diversity: one pass taking the best remaining candidate per company before
  // any company gets a second slot.
  const byCompany = new Map<string, TriageCandidate[]>();
  for (const c of eligible) {
    if (taken.has(c.id)) continue;
    const key = c.company?.trim().toLowerCase() || "__none__";
    if (!byCompany.has(key)) byCompany.set(key, []);
    byCompany.get(key)!.push(c);
  }
  for (const list of byCompany.values()) {
    list.sort((a, b) => b.prior - a.prior);
  }
  const roundRobin: TriageCandidate[] = [];
  let depth = 0;
  let added = true;
  while (added && roundRobin.length < limit) {
    added = false;
    for (const list of byCompany.values()) {
      if (list[depth]) {
        roundRobin.push(list[depth]);
        added = true;
      }
    }
    depth++;
  }
  take(roundRobin, limit - picked.length);

  // Backfill if a pool ran dry, so a small orbit still gets a full shortlist.
  take([...highPrior, ...highEvidence], limit - picked.length);

  return picked.slice(0, limit);
}
