import { createDiscoveryRunHandler } from "@/lib/outreach/discovery/run";
import type { JobHandlers } from "@/lib/outreach/jobs/worker";
import { createRankingBatchHandler, createRerankHandler } from "@/lib/outreach/ranking/apply";
import { createResearchPersonHandler } from "@/lib/outreach/research/attempt";

/** Every registered generation-2 job handler. */
export function defaultJobHandlers(): JobHandlers {
  return {
    "discovery.run": createDiscoveryRunHandler(),
    "ranking.batch": createRankingBatchHandler(),
    "ranking.rerank": createRerankHandler(),
    "research.person": createResearchPersonHandler(),
  };
}
