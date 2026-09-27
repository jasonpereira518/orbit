/**
 * The CRM card's server half, for either CRM: the status it shows, "Sync now", and disconnect.
 * The Server Actions in src/actions/crm.ts are thin shells over these, so this runs in a smoke.
 */
import { formatDistanceToNow } from "date-fns";
import {
  claimConnectorConnectionForUser,
  deleteConnectorConnection,
  getConnectorRefreshToken,
  listConnectorConnections,
  markConnectorSyncResult,
  markConnectorSyncSucceeded,
  type ClaimedConnectorConnection,
  type ConnectorConnectionSummary,
} from "@/lib/connectors/connections";
import { isOAuthConfigured } from "@/lib/connectors/oauth";
import { revokeHubspotToken } from "@/lib/crm/hubspot/api";
import { syncHubspot } from "@/lib/crm/hubspot/sync";
import { crmCounts, deleteCrmRecordsForConnector } from "@/lib/crm/records";
import { revokeSalesforceToken } from "@/lib/crm/salesforce/api";
import { syncSalesforce } from "@/lib/crm/salesforce/sync";
import {
  CRM_PROVIDERS,
  DEMO_CRM_ACCOUNT_REF,
  crmErrorLine,
  crmProviderLabel,
  type CrmConnectionView,
  type CrmConnectorId,
  type CrmStatus,
  type CrmSyncNowResult,
  type CrmSyncResult,
} from "@/lib/crm/types";
import { getEntitlements } from "@/lib/entitlements";
import { UserFacingError } from "@/lib/errors";
import { SYNC_LEASE_MS } from "@/lib/provider-connections";
import { RATE_LIMITS, consumeBucket, isRateLimitedError } from "@/lib/rate-limit";
import { reportError } from "@/lib/report-error";

/**
 * A person is waiting on the button: shorter than the scheduler's share, and resumable. The
 * (main) layout's `maxDuration` is 60 s, and the budget is only checked between pages, so it
 * leaves room for one overshooting page (a 15 s search timeout plus its persist) — a run the
 * platform kills holds the lease for its full term.
 */
export const SYNC_NOW_BUDGET_MS = 30_000;

const SYNCS: Record<
  CrmConnectorId,
  (conn: ClaimedConnectorConnection, opts: { budgetMs: number }) => Promise<CrmSyncResult>
> = {
  hubspot: (conn, opts) => syncHubspot(conn, opts),
  salesforce: (conn, opts) => syncSalesforce(conn, opts),
};

function defaultRevoke(connectorId: CrmConnectorId): (refreshToken: string, instanceUrl: string | null) => Promise<boolean> {
  return async (token, instanceUrl) => {
    if (!isOAuthConfigured(connectorId)) return false;
    if (connectorId === "hubspot") return revokeHubspotToken(token);
    return instanceUrl ? revokeSalesforceToken(instanceUrl, token) : false;
  };
}

function viewOf(id: CrmConnectorId, connection: ConnectorConnectionSummary, leaseCutoff: number): CrmConnectionView {
  return {
    connectorId: id,
    label: connection.label,
    status: connection.status,
    syncing: connection.syncStatus === "syncing" && (connection.syncStartedAt?.getTime() ?? 0) > leaseCutoff,
    lastSyncedAgo: connection.lastSyncedAt ? formatDistanceToNow(connection.lastSyncedAt, { addSuffix: true }) : null,
    error: crmErrorLine(connection.syncError),
    demo: connection.accountRef === DEMO_CRM_ACCOUNT_REF,
    paused: connection.status === "active" && connection.nextSyncAt === null && connection.syncError !== null,
  };
}

export async function crmStatusFor(userId: string): Promise<CrmStatus> {
  const [entitlements, connections] = await Promise.all([getEntitlements(userId), listConnectorConnections(userId)]);
  const leaseCutoff = Date.now() - SYNC_LEASE_MS;
  const providers = await Promise.all(
    CRM_PROVIDERS.map(async ({ id, label }): Promise<CrmStatus["providers"][number]> => {
      const connection = connections.find((c) => c.connectorId === id) ?? null;
      return {
        id,
        label,
        configured: isOAuthConfigured(id),
        connection: connection ? viewOf(id, connection, leaseCutoff) : null,
        counts: connection ? await crmCounts(userId, id) : null,
      };
    })
  );
  return { entitled: entitlements.canUseCrm, providers };
}

export async function runCrmSyncNow(
  userId: string,
  connectorId: CrmConnectorId,
  deps: {
    sync?: (conn: ClaimedConnectorConnection, opts: { budgetMs: number }) => Promise<CrmSyncResult>;
    consume?: () => Promise<unknown>;
  } = {}
): Promise<CrmSyncNowResult> {
  const label = crmProviderLabel(connectorId);
  const didntAnswer = `${label} didn’t answer — the next automatic sync will try again`;
  const connections = await listConnectorConnections(userId);
  const summary = connections.find((c) => c.connectorId === connectorId) ?? null;
  if (!summary) throw new UserFacingError(`Connect ${label} first`);
  if (summary.accountRef === DEMO_CRM_ACCOUNT_REF) {
    throw new UserFacingError(`The demo’s ${label} data is sample data — there’s nothing to sync`);
  }
  if (summary.status === "needs_reauth") {
    throw new UserFacingError(`${label} needs you to reconnect — use Reconnect, then sync`);
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

  const sync = deps.sync ?? SYNCS[connectorId];
  let result: CrmSyncResult;
  try {
    result = await sync(conn, { budgetMs: SYNC_NOW_BUDGET_MS });
  } catch (err) {
    // What the scheduler does with a throw: retryable, backed off. The card gets words; the
    // raw error goes to the report, never the row.
    reportError(err, { where: "crm.sync-now", userId, level: "warning", extra: { connectorId } });
    await markConnectorSyncResult(
      conn.id,
      { ok: false, error: didntAnswer, retryable: true },
      undefined,
      { leaseStartedAt: conn.leaseStartedAt }
    );
    throw new UserFacingError(didntAnswer);
  }
  // The backstop: a no-op when the sync recorded its own outcome, which both CRM syncs always do.
  await markConnectorSyncSucceeded(conn.id, undefined, { leaseStartedAt: conn.leaseStartedAt });
  const message =
    result.outcome === "needs_reauth"
      ? `${label} needs you to reconnect — use Reconnect, then sync`
      : result.outcome === "stopped"
        ? crmErrorLine(result.message ?? null)
        : (result.message ?? null);
  return { outcome: result.outcome, pages: result.pages, records: result.records, message };
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
 * sync can start once this holds it. The claim also writes a new `sync_started_at`, which is
 * how this and a run that outlived its lease term meet: both CRM syncs check
 * `connectorLeaseHeld` before every page they persist and before they record their end, see the
 * lease it claimed is gone, and stop writing. A purge or a reconnect, which take no claim, end
 * a run the same way — the row is gone, or its lease reset.
 *
 * A `needs_reauth` connection skips the claim: both claims require `status = 'active'`, so
 * nothing can be holding its lease no matter what its (possibly stale) `sync_status` says.
 */
export async function disconnectCrm(
  userId: string,
  connectorId: CrmConnectorId,
  deps: { revoke?: (refreshToken: string, instanceUrl: string | null) => Promise<boolean> } = {}
): Promise<void> {
  const label = crmProviderLabel(connectorId);
  const connections = await listConnectorConnections(userId);
  const summary = connections.find((c) => c.connectorId === connectorId) ?? null;
  if (summary && summary.status === "active") {
    const held = await claimConnectorConnectionForUser(userId, connectorId);
    if (!held) throw new UserFacingError(`${label} is syncing right now — disconnect again in a minute`);
  }
  if (summary && summary.accountRef !== DEMO_CRM_ACCOUNT_REF) {
    const refresh = await getConnectorRefreshToken(userId, connectorId);
    const revoke = deps.revoke ?? defaultRevoke(connectorId);
    // Best effort: a refused revoke still disconnects, but leaves a trace — the grant may live
    // on at the provider until the person removes the app there.
    if (refresh && !(await revoke(refresh, summary.instanceUrl))) {
      reportError(new Error(`${label} did not accept the token revoke`), {
        where: "crm.disconnect.revoke",
        userId,
        level: "warning",
        extra: { connectorId },
      });
    }
  }
  await deleteConnectorConnection(userId, connectorId);
  await deleteCrmRecordsForConnector(userId, connectorId);
}
