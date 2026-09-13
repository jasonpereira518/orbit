import type { JobHandlers } from "@/lib/outreach/jobs/worker";
import { createRankingBatchHandler, createRerankHandler } from "@/lib/outreach/ranking/apply";

/** Every registered generation-2 job handler. Tasks 14–15 add their kinds here. */
export function defaultJobHandlers(): JobHandlers {
  return {
    "ranking.batch": createRankingBatchHandler(),
    "ranking.rerank": createRerankHandler(),
  };
}
