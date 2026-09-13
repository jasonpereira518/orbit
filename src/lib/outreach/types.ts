/**
 * Shared vocabulary for generation-2 Outreach. Pure: nothing here reaches the database, so
 * client components and `pure` smoke scripts may import it. Stored-shape types are declared
 * beside their columns in `src/db/schema.ts` and re-exported here as types only (erased at
 * build, so importing this module never pulls in the schema).
 */
export type {
  OutreachBrief,
  OutreachChannel,
  OutreachConfidence,
  OutreachCriteria,
  OutreachCriterion,
  OutreachCriterionKind,
  OutreachCriterionVerdict,
  OutreachEmailStatus,
  OutreachFundingSource,
  OutreachIdentityKind,
  OutreachJobKind,
  OutreachJobStatus,
  OutreachProspectFlags,
  OutreachProspectOrigin,
  OutreachRankExplanation,
  OutreachRankTier,
  OutreachResearchState,
  OutreachRunPhase,
  OutreachRunPlan,
  OutreachRunStats,
  OutreachRunStatus,
  OutreachSendingMethod,
  OutreachSetupStep,
  OutreachVerdict,
} from "@/db/schema";

export const CRITERION_KINDS = ["role", "organization", "geography", "experience", "other"] as const;
export const SETUP_STEPS = ["describe", "audience", "people", "review", "send", "tracking"] as const;
export const RANK_TIERS = ["strong", "possible", "weak", "filtered"] as const;

/**
 * The shape of `completeJson` in `src/lib/ai.ts`, as a seam. Pure modules take one of these
 * instead of importing `ai.ts` (which reaches the database for the user's key), so the same
 * code runs against a deterministic fake in the smoke harness.
 */
export type JsonCompleter = (
  userId: string,
  input: {
    system: string;
    user: string;
    temperature?: number;
    maxOutputTokens?: number;
    operation?: string;
    speed?: "fast";
  }
) => Promise<string>;
