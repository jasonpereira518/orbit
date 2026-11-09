/**
 * The Leads page's list: the user's leads, each with who on their team knows them, hottest
 * first. One read of the leads, one read of their CRM links when any are CRM-tied, and at
 * most two warm-path statements however long the list — P2's `warmPathsForTargets` does the
 * matching, so the privacy SQL has exactly one copy.
 */
import type { Lead, LeadStatus } from "@/db/schema";
import { connectorById } from "@/lib/connectors/registry";
import { crmRecordLinks } from "@/lib/crm/records";
import { leadTargetIdentity } from "./lead-identity";
import { listLeads } from "./store";
import { WARMTH_RANK, type WarmPath } from "./warm-path";
import { warmPathsForTargets } from "./warm-path-query";

/** `crm` is where the lead lives in the CRM it came from, when it came from one. */
export type PipelineRow = { lead: Lead; path: WarmPath | null; crm: { label: string; url: string } | null };

/** `team` says why every `path` is null when it is not "ok". */
export type Pipeline = { team: "ok" | "no_team" | "not_sharing"; rows: PipelineRow[] };

const rankOf = (row: PipelineRow) => WARMTH_RANK[row.path?.warmth ?? "cold"];

export async function loadPipeline(
  userId: string,
  opts: { statuses?: readonly LeadStatus[] } = {}
): Promise<Pipeline> {
  const list = await listLeads(userId, opts);
  const tied = list.flatMap((lead) => (lead.crmRecordId ? [lead.crmRecordId] : []));
  const links = tied.length ? await crmRecordLinks(userId, tied) : new Map<string, { connectorId: string; remoteUrl: string | null }>();
  const crmFor = (lead: Lead): PipelineRow["crm"] => {
    const link = lead.crmRecordId ? links.get(lead.crmRecordId) : undefined;
    if (!link?.remoteUrl) return null;
    return { label: connectorById(link.connectorId)?.label ?? "your CRM", url: link.remoteUrl };
  };
  const result = await warmPathsForTargets(
    userId,
    list.map((lead) => ({ key: lead.id, ...leadTargetIdentity(lead) }))
  );
  if (result.status !== "ok") {
    return { team: result.status, rows: list.map((lead) => ({ lead, path: null, crm: crmFor(lead) })) };
  }
  const rows = list.map((lead) => ({ lead, path: result.paths.get(lead.id) ?? null, crm: crmFor(lead) }));
  rows.sort(
    (a, b) => rankOf(a) - rankOf(b) || b.lead.updatedAt.getTime() - a.lead.updatedAt.getTime()
  );
  return { team: "ok", rows };
}
