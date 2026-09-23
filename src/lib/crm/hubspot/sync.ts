/**
 * One HubSpot sync run for one claimed connection: the contacts the person who connected
 * OWNS in HubSpot (an account-level token reads the whole portal, so the owner filter is
 * ours to apply), customers into contacts, everyone else into the Leads pipeline.
 *
 * It records its own outcome — the contract on `ConnectorManifest.sync`: a cursor after every
 * page (so a run killed at its time limit resumes at the next page), and the run's end. What
 * it throws is retryable by construction; everything the person has to act on is resolved on
 * the row before it returns.
 */
import type { ClaimedConnectorConnection } from "@/lib/connectors/connections";
import { markConnectorSyncResult, saveConnectorCursor } from "@/lib/connectors/connections";
import { ConnectorNeedsReauthError } from "@/lib/connectors/auth-errors";
import { openConnectorAuth, type ConnectorAuthDeps } from "@/lib/connectors/token";
import { persistCrmPage } from "@/lib/crm/persist";
import type { CrmPerson } from "@/lib/crm/types";
import { getEntitlements } from "@/lib/entitlements";
import { finalizeIngest, openIngestContext } from "@/lib/ingest/events";
import { HubspotApiError, findHubspotOwner, introspectHubspotToken, searchHubspotContacts } from "./api";
import {
  advanceWindow,
  buildContactSearchBody,
  cursorFromWindow,
  identityFromCursor,
  mapHubspotContact,
  parseHubspotDate,
  windowFromCursor,
  type HubspotIdentity,
} from "./mapping";

/** Inside the scheduler's 60 s per-connection share, with room to record the result. */
export const HUBSPOT_SYNC_BUDGET_MS = 45_000;

export type HubspotSyncDeps = {
  fetchImpl?: typeof fetch;
  now?: () => Date;
  budgetMs?: number;
  auth?: ConnectorAuthDeps;
};

export type HubspotSyncResult = {
  outcome: "complete" | "partial" | "needs_reauth" | "stopped";
  pages: number;
  records: number;
  contactsCreated: number;
  leadsCreated: number;
  blocked: number;
  message?: string;
};

const NOT_ENTITLED = "HubSpot sync is on Orbit Pro and Lifetime — upgrade to keep it running";
const NO_OWNER =
  "HubSpot has no owner record for the person who connected, so no contacts are assigned to you — ask a HubSpot admin to add you as a user, then sync again";

export async function syncHubspot(
  conn: ClaimedConnectorConnection,
  deps: HubspotSyncDeps = {}
): Promise<HubspotSyncResult> {
  const now = deps.now ?? (() => new Date());
  const fetchImpl = deps.fetchImpl ?? fetch;
  const budget = deps.budgetMs ?? HUBSPOT_SYNC_BUDGET_MS;
  const started = now().getTime();
  const result: HubspotSyncResult = { outcome: "complete", pages: 0, records: 0, contactsCreated: 0, leadsCreated: 0, blocked: 0 };

  const stop = async (message: string): Promise<HubspotSyncResult> => {
    await markConnectorSyncResult(conn.id, { ok: false, error: message, retryable: false });
    return { ...result, outcome: "stopped", message };
  };

  const entitlements = await getEntitlements(conn.userId);
  if (!entitlements.canUseCrm) return stop(NOT_ENTITLED);

  const auth = openConnectorAuth(conn, deps.auth);
  try {
    let identity: HubspotIdentity | null = identityFromCursor(conn.cursor);
    let cursor = conn.cursor;
    // Reconnected to a different HubSpot account: the old window describes someone else's data.
    if (identity && conn.accountRef && identity.portalId !== conn.accountRef) {
      identity = null;
      cursor = null;
    }
    if (!identity) {
      const info = await auth.call((token) => introspectHubspotToken(token, fetchImpl));
      const owner = await auth.call((token) =>
        findHubspotOwner(token, { userId: info.userId, email: info.userEmail }, fetchImpl)
      );
      if (!owner) return stop(NO_OWNER);
      identity = { portalId: info.hubId, ownerId: owner.id, ...(info.userId ? { hubUserId: info.userId } : {}) };
      cursor = null;
    }
    const who: HubspotIdentity = identity;

    let window = windowFromCursor(cursor, now());
    await saveConnectorCursor(conn.id, cursorFromWindow(window, who));

    const ctx = await openIngestContext(conn.userId, { source: "hubspot", createsContacts: true, reportResolutions: true });
    let done = false;
    try {
      while (now().getTime() - started < budget) {
        const page = await auth.call((token) =>
          searchHubspotContacts(token, buildContactSearchBody({ ownerId: who.ownerId, since: window.since, after: window.after }), fetchImpl)
        );
        const people = page.results
          .map((raw) => mapHubspotContact(raw, { portalId: who.portalId }))
          .filter((p): p is CrmPerson => p !== null);
        const stats = await persistCrmPage(ctx, "hubspot", people, now());
        result.pages++;
        result.records += stats.records;
        result.contactsCreated += stats.contactsCreated;
        result.leadsCreated += stats.leadsCreated;
        result.blocked += stats.blocked;

        // From the RAW results: a page of skipped (nameless, archived) records must still move
        // the window, or the next query would read the same page forever.
        let maxModified: string | null = null;
        for (const raw of page.results) {
          const at = parseHubspotDate(raw.properties?.lastmodifieddate ?? raw.updatedAt);
          if (at && (!maxModified || at.getTime() > Date.parse(maxModified))) maxModified = at.toISOString();
        }
        const step = advanceWindow(window, { maxModified, nextAfter: page.nextAfter }, now());
        window = step.window;
        await saveConnectorCursor(conn.id, cursorFromWindow(window, who));
        if (step.done) {
          done = true;
          break;
        }
      }
    } finally {
      await finalizeIngest(ctx);
    }

    await markConnectorSyncResult(conn.id, {
      ok: true,
      cursor: cursorFromWindow(window, who),
      ...(done ? {} : { nextSyncAt: now() }),
    });
    return { ...result, outcome: done ? "complete" : "partial" };
  } catch (err) {
    if (err instanceof ConnectorNeedsReauthError) return { ...result, outcome: "needs_reauth", message: err.message };
    if (err instanceof HubspotApiError && !err.retryable) return stop(err.message);
    throw err;
  }
}
