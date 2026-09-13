import type { JobHandlers } from "@/lib/outreach/jobs/worker";
import { createRankingBatchHandler, createRerankHandler } from "@/lib/outreach/ranking/apply";
import { createResearchPersonHandler } from "@/lib/outreach/research/attempt";

/** Every registered generation-2 job handler. Task 15 adds its kind here. */
export function defaultJobHandlers(): JobHandlers {
  return {
    "ranking.batch": createRankingBatchHandler(),
    "ranking.rerank": createRerankHandler(),
    "research.person": createResearchPersonHandler(),
  };
}
