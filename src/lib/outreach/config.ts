/**
 * Every tunable number in generation-2 Outreach, in one place (spec §3 "Defaults").
 * Allowances read the environment at call time so they can be changed without a deploy of
 * code and so the smoke harness can exercise an override.
 */
function intFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  return Number.isInteger(value) && value >= 0 ? value : fallback;
}

export const OUTREACH_ALLOWANCES = {
  /** Research credits granted each monthly period on Orbit Pro. */
  get orbitMonthly(): number {
    return intFromEnv("OUTREACH_CREDITS_PRO_MONTHLY", 250);
  },
  /** Research credits granted once on Orbit Lifetime. */
  get lifetimeOnce(): number {
    return intFromEnv("OUTREACH_CREDITS_LIFETIME_ONCE", 100);
  },
};

export const OUTREACH_LIMITS = {
  orbitSearchRunsPerDay: 5,
  /** Brave API calls (pages) per discovery run. */
  braveQueriesPerRun: 15,
  resultsPerQuery: 20,
  maxPagesPerQuery: 2,
  maxPlannedQueries: 8,
  defaultResearchBudget: 25,
  maxResearchBudget: 100,
  researchAttemptTimeoutMs: 45_000,
  researchSupportQueries: 2,
  rankingBatchSize: 8,
  evidencePerCandidate: 6,
  snippetMaxChars: 1_000,
  emailDailyCeiling: 50,
  emailSpacingMs: 20_000,
  linkedinDailyInviteCap: 20,
  linkedinSpacingMs: [60_000, 120_000] as const,
  linkedinNoteDefaultLimit: 200,
  linkedinNoteMaxLimit: 300,
  followUpDelayDays: 7,
  maxFollowUpSuggestions: 2,
  mailSyncIntervalMs: 5 * 60_000,
} as const;

/** Approximate list prices in USD micros. Metering only — never used to enforce anything. */
export const PROVIDER_COST_MICROS = {
  braveSearch: 5_000,
  apolloMatch: 30_000,
} as const;

export const WORKER = {
  /** Total wall-clock one worker invocation may spend (route maxDuration is 300 s). */
  passBudgetMs: 240_000,
  /** Soft deadline handed to each job; handlers yield with `continue` before it. */
  jobBudgetMs: 60_000,
  leaseMs: 120_000,
  claimBatch: 4,
} as const;
