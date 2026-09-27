/**
 * One Salesforce sync run for one claimed connection: the Contacts and Leads the person who
 * connected OWNS (`OwnerId` — the API user can usually read far more), Contacts into work
 * contacts, open Leads into the Leads pipeline, converted Leads as customers.
 *
 * The same contract as `syncHubspot` (read its doc): a cursor after every page, the run's end
 * recorded by the run, retryable throws, and no write — not even a stop — once the lease is
 * gone. Salesforce-specific: every call goes to the org's own `instance_url`, identity comes
 * from the connect (Ruling 9), and paging is a keyset on `(SystemModstamp, Id)` (Ruling 6).
 */
import type { ClaimedConnectorConnection } from "@/lib/connectors/connections";
import { connectorLeaseHeld, markConnectorSyncResult, saveConnectorCursor } from "@/lib/connectors/connections";
import { ConnectorNeedsReauthError } from "@/lib/connectors/auth-errors";
import { openConnectorAuth, type ConnectorAuthDeps } from "@/lib/connectors/token";
import { persistCrmPage } from "@/lib/crm/persist";
import type { CrmPerson, CrmSyncResult } from "@/lib/crm/types";
import { getEntitlements } from "@/lib/entitlements";
import { finalizeIngest, openIngestContext, type IngestContext } from "@/lib/ingest/events";
import { SalesforceApiError, querySalesforce } from "./api";
import {
  SALESFORCE_PAGE,
  advanceProgress,
  buildOwnedQuery,
  cursorFromProgress,
  identityFromCursor,
  isTrustedSalesforceUrl,
  mapSalesforceRecord,
  markOf,
  progressFromCursor,
} from "./mapping";

/** Inside the scheduler's 60 s per-connection share, with room to record the result. */
export const SALESFORCE_SYNC_BUDGET_MS = 45_000;

export type SalesforceSyncDeps = {
  fetchImpl?: typeof fetch;
  now?: () => Date;
  budgetMs?: number;
  auth?: ConnectorAuthDeps;
};

const NOT_ENTITLED = "Salesforce sync is on Orbit Pro and Lifetime — upgrade to keep it running";
const RECONNECT = "Salesforce didn’t say which org and user to sync — reconnect Salesforce";
// Starts "Salesforce " so `crmErrorLine` shows it, not the generic line.
const LEASE_LOST = "Salesforce was reconnected or disconnected during the sync — nothing more was saved";
// Ruling 8's lean fallback already ran and STILL got INVALID_FIELD: reading the ones this
// user can see is not possible, so `stop()`'s own "Orbit will read the ones you can see" line
// would be false — the sync just stopped instead.
const LEAN_BLOCKED =
  "Salesforce won’t let this connection read contact and lead names, emails and companies — ask a Salesforce admin to grant read access, then sync again";

export async function syncSalesforce(conn: ClaimedConnectorConnection, deps: SalesforceSyncDeps = {}): Promise<CrmSyncResult> {
  const now = deps.now ?? (() => new Date());
  const fetchImpl = deps.fetchImpl ?? fetch;
  const budget = deps.budgetMs ?? SALESFORCE_SYNC_BUDGET_MS;
  const started = now().getTime();
  const result: CrmSyncResult = { outcome: "complete", pages: 0, records: 0, contactsCreated: 0, leadsCreated: 0, blocked: 0 };

  const holdsLease = () => connectorLeaseHeld(conn.id, conn.leaseStartedAt);
  // Nothing recorded: the row is gone, or belongs to a newer run.
  const leaseLost = (): CrmSyncResult => ({ ...result, outcome: "stopped", message: LEASE_LOST });
  // A stop disarms the row — so it checks the lease first, like every other write (Ruling 12b).
  const stop = async (message: string): Promise<CrmSyncResult> => {
    if (!(await holdsLease())) return leaseLost();
    await markConnectorSyncResult(conn.id, { ok: false, error: message, retryable: false }, undefined, {
      leaseStartedAt: conn.leaseStartedAt,
    });
    return { ...result, outcome: "stopped", message };
  };

  const entitlements = await getEntitlements(conn.userId);
  if (!entitlements.canUseCrm) return stop(NOT_ENTITLED);

  const instanceUrl = conn.instanceUrl;
  const identity = identityFromCursor(conn.cursor);
  if (!isTrustedSalesforceUrl(instanceUrl) || !identity || identity.orgId !== conn.accountRef) return stop(RECONNECT);

  const auth = openConnectorAuth(conn, deps.auth);
  let progress = progressFromCursor(conn.cursor);
  let ctx: IngestContext | null = null;
  let done = false;
  let lost = false;
  try {
    try {
      while (now().getTime() - started < budget) {
        const object = progress.phase;
        const after = object === "Contact" ? progress.contact : progress.lead;
        let page;
        try {
          // `conn.instanceUrl`, not the local: a refresh inside `auth.call` may have moved it.
          page = await auth.call((token) =>
            querySalesforce(token, conn.instanceUrl ?? instanceUrl, buildOwnedQuery(object, { ownerId: identity.userId, after, lean: progress.lean }), fetchImpl)
          );
        } catch (err) {
          // Ruling 8: a field this user can't see. Read the ones they can, for good.
          if (err instanceof SalesforceApiError && err.kind === "invalid_field" && !progress.lean) {
            progress = { ...progress, lean: true };
            continue;
          }
          throw err;
        }
        const people = page.records
          .map((raw) => mapSalesforceRecord(object, raw, { instanceUrl: conn.instanceUrl ?? instanceUrl }))
          .filter((p): p is CrmPerson => p !== null);
        if (!(await holdsLease())) {
          lost = true;
          break;
        }
        if (people.length > 0) {
          ctx ??= await openIngestContext(conn.userId, { source: "salesforce", createsContacts: true, reportResolutions: true });
          const stats = await persistCrmPage(ctx, "salesforce", people, now());
          result.records += stats.records;
          result.contactsCreated += stats.contactsCreated;
          result.leadsCreated += stats.leadsCreated;
          result.blocked += stats.blocked;
        }
        result.pages++;
        // From the RAW records: a page of skipped (nameless) records must still move the mark.
        const last = page.records.length ? markOf(page.records[page.records.length - 1]) : null;
        const step = advanceProgress(progress, { last, full: page.records.length >= SALESFORCE_PAGE });
        progress = step.progress;
        await saveConnectorCursor(conn.id, cursorFromProgress(progress, identity), { leaseStartedAt: conn.leaseStartedAt });
        if (step.done) {
          done = true;
          break;
        }
      }
    } finally {
      // A lost lease writes nothing more — not even the derived-state kick for pages already in.
      if (ctx && !lost) await finalizeIngest(ctx);
    }

    if (lost || !(await holdsLease())) return leaseLost();
    await markConnectorSyncResult(
      conn.id,
      { ok: true, cursor: cursorFromProgress(progress, identity), ...(done ? {} : { nextSyncAt: now() }) },
      undefined,
      { leaseStartedAt: conn.leaseStartedAt }
    );
    return { ...result, outcome: done ? "complete" : "partial" };
  } catch (err) {
    if (err instanceof ConnectorNeedsReauthError) return { ...result, outcome: "needs_reauth", message: err.message };
    // Ruling 8's lean fallback already ran once (that's the only way an `invalid_field` error
    // reaches here): reading the ones this user can see failed too, so the fixed sentence that
    // normally goes with it would be false.
    if (err instanceof SalesforceApiError && err.kind === "invalid_field") return stop(LEAN_BLOCKED);
    if (err instanceof SalesforceApiError && !err.retryable) return stop(err.message);
    throw err;
  }
}
