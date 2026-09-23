/**
 * The CRM card's server half: what it shows, "Sync now", and disconnect. The Server Actions in
 * src/actions/crm.ts are thin shells over these, so this runs in a smoke.
 */
import { formatDistanceToNow } from "date-fns";
import {
  claimConnectorConnectionForUser,
  deleteConnectorConnection,
  getConnectorConnection,
  getConnectorRefreshToken,
  markConnectorSyncResult,
  markConnectorSyncSucceeded,
  type ClaimedConnectorConnection,
} from "@/lib/connectors/connections";
import { isOAuthConfigured } from "@/lib/connectors/oauth";
import type { CrmConnectorId } from "@/lib/crm/connect";
import { revokeHubspotToken } from "@/lib/crm/hubspot/api";
import { syncHubspot, type HubspotSyncResult } from "@/lib/crm/hubspot/sync";
import { crmCounts, deleteCrmRecordsForConnector } from "@/lib/crm/records";
import { DEMO_CRM_ACCOUNT_REF, crmErrorLine, type CrmStatus, type CrmSyncNowResult } from "@/lib/crm/types";
import { getEntitlements } from "@/lib/entitlements";
import { UserFacingError } from "@/lib/errors";
import { SYNC_LEASE_MS } from "@/lib/provider-connections";
import { RATE_LIMITS, consumeBucket, isRateLimitedError } from "@/lib/rate-limit";
import { reportError } from "@/lib/report-error";

const DIDNT_ANSWER = "HubSpot didn’t answer — the next automatic sync will try again";

/** A person is waiting on the button: shorter than the scheduler's share, and resumable. */
export const SYNC_NOW_BUDGET_MS = 40_000;

export async function crmStatusFor(userId: string): Promise<CrmStatus> {
  const [entitlements, connection] = await Promise.all([
    getEntitlements(userId),
    getConnectorConnection(userId, "hubspot"),
  ]);
  const counts = connection ? await crmCounts(userId, "hubspot") : null;
  const leaseCutoff = Date.now() - SYNC_LEASE_MS;
  return {
    entitled: entitlements.canUseCrm,
    configured: isOAuthConfigured("hubspot"),
    connection: connection
      ? {
          connectorId: "hubspot",
          label: connection.label,
          status: connection.status,
          syncing: connection.syncStatus === "syncing" && (connection.syncStartedAt?.getTime() ?? 0) > leaseCutoff,
          lastSyncedAgo: connection.lastSyncedAt ? formatDistanceToNow(connection.lastSyncedAt, { addSuffix: true }) : null,
          error: crmErrorLine(connection.syncError),
          demo: connection.accountRef === DEMO_CRM_ACCOUNT_REF,
        }
      : null,
    counts,
  };
}

export async function runCrmSyncNow(
  userId: string,
  connectorId: CrmConnectorId,
  deps: {
    sync?: (conn: ClaimedConnectorConnection, opts: { budgetMs: number }) => Promise<HubspotSyncResult>;
    consume?: () => Promise<unknown>;
  } = {}
): Promise<CrmSyncNowResult> {
  const summary = await getConnectorConnection(userId, connectorId);
  if (!summary) throw new UserFacingError("Connect HubSpot first");
  if (summary.accountRef === DEMO_CRM_ACCOUNT_REF) {
    throw new UserFacingError("The demo’s HubSpot data is sample data — there’s nothing to sync");
  }
  if (summary.status === "needs_reauth") {
    throw new UserFacingError("HubSpot needs you to reconnect — use Reconnect, then sync");
  }
  try {
    await (deps.consume ?? (() => consumeBucket("providerSync", userId, RATE_LIMITS.providerSync)))();
  } catch (err) {
    if (isRateLimitedError(err)) {
      throw new UserFacingError("You’ve synced a few times this hour — the automatic sync keeps running");
    }
    throw err;
  }
  const conn = await claimConnectorConnectionForUser(userId, connectorId);
  if (!conn) throw new UserFacingError("A sync is already running — give it a minute");

  const sync = deps.sync ?? ((c, opts) => syncHubspot(c, opts));
  let result: HubspotSyncResult;
  try {
    result = await sync(conn, { budgetMs: SYNC_NOW_BUDGET_MS });
  } catch (err) {
    // What the scheduler does with a throw: retryable, backed off. The card gets words; the
    // raw error goes to the report, never the row.
    reportError(err, { where: "crm.sync-now", userId, level: "warning", extra: { connectorId } });
    await markConnectorSyncResult(conn.id, { ok: false, error: DIDNT_ANSWER, retryable: true });
    throw new UserFacingError(DIDNT_ANSWER);
  }
  // The backstop: a no-op when the sync recorded its own outcome, which HubSpot's always does.
  await markConnectorSyncSucceeded(conn.id);
  return { outcome: result.outcome, pages: result.pages, records: result.records, message: result.message ?? null };
}

/**
 * Revoke (best effort), then forget. No plan check: a downgraded account must always be able
 * to disconnect. The contacts a sync created stay — they are the person's now — and CRM leads
 * stay as leads, untied by the foreign key.
 *
 * An active connection claims the sync lease FIRST, before either delete. Without it, a sync
 * already in flight (the scheduler, or "Sync now" in another tab) keeps writing
 * `crm_records`/leads from its in-memory snapshot for up to its budget after this function
 * returns — its terminal `markConnectorSyncResult` then silently no-ops on the missing row —
 * and the records the disconnect dialog promised to forget come back. Claiming the lease
 * through the same predicate the scheduler and "Sync now" both claim through guarantees no
 * sync can start once this holds it. A `needs_reauth` connection skips the claim: both claims
 * require `status = 'active'`, so nothing can be holding its lease no matter what its
 * (possibly stale) `sync_status` says.
 */
export async function disconnectCrm(
  userId: string,
  connectorId: CrmConnectorId,
  deps: { revoke?: (refreshToken: string) => Promise<boolean> } = {}
): Promise<void> {
  const summary = await getConnectorConnection(userId, connectorId);
  if (summary && summary.status === "active") {
    const held = await claimConnectorConnectionForUser(userId, connectorId);
    if (!held) throw new UserFacingError("HubSpot is syncing right now — disconnect again in a minute");
  }
  if (summary && summary.accountRef !== DEMO_CRM_ACCOUNT_REF) {
    const refresh = await getConnectorRefreshToken(userId, connectorId);
    const revoke = deps.revoke ?? ((token: string) => (isOAuthConfigured(connectorId) ? revokeHubspotToken(token) : Promise.resolve(false)));
    if (refresh) await revoke(refresh);
  }
  await deleteConnectorConnection(userId, connectorId);
  await deleteCrmRecordsForConnector(userId, connectorId);
}
