/**
 * The Leads page's list: the user's leads, each with who on their team knows them, hottest
 * first. One read of the leads and at most two warm-path statements however long the list —
 * P2's `warmPathsForTargets` does the matching, so the privacy SQL has exactly one copy.
 */
import type { Lead, LeadStatus } from "@/db/schema";
import { leadTargetIdentity } from "./lead-identity";
import { listLeads } from "./store";
import { WARMTH_RANK, type WarmPath } from "./warm-path";
import { warmPathsForTargets } from "./warm-path-query";

export type PipelineRow = { lead: Lead; path: WarmPath | null };

/** `team` says why every `path` is null when it is not "ok". */
export type Pipeline = { team: "ok" | "no_team" | "not_sharing"; rows: PipelineRow[] };

const rankOf = (row: PipelineRow) => WARMTH_RANK[row.path?.warmth ?? "cold"];

export async function loadPipeline(
  userId: string,
  opts: { statuses?: readonly LeadStatus[] } = {}
): Promise<Pipeline> {
  const list = await listLeads(userId, opts);
  const result = await warmPathsForTargets(
    userId,
    list.map((lead) => ({ key: lead.id, ...leadTargetIdentity(lead) }))
  );
  if (result.status !== "ok") {
    return { team: result.status, rows: list.map((lead) => ({ lead, path: null })) };
  }
  const rows = list.map((lead) => ({ lead, path: result.paths.get(lead.id) ?? null }));
  rows.sort(
    (a, b) => rankOf(a) - rankOf(b) || b.lead.updatedAt.getTime() - a.lead.updatedAt.getTime()
  );
  return { team: "ok", rows };
}
