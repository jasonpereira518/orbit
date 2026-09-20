/**
 * The only module that names `connector_connections`.
 *
 * Mirrors `src/lib/events/connections.ts`, which solves the same problem for event
 * providers, and borrows its lease, failure ceiling and backoff from
 * `provider-connections.ts` rather than restating them — three sync families with three
 * different give-up rules would be three different operational stories for one symptom.
 *
 * Deliberately free of `next/server` and `next/cache` imports: the sync scheduler and its
 * smoke tests both load this, and importing `next/server` alone retains the Node event loop
 * and hangs any `tsx` script.
 */
import { and, eq, sql } from "drizzle-orm";
import { getDb, rowsOf } from "@/db";
import { connectorConnections, type ConnectorSyncCursor } from "@/db/schema";
import { decryptOrNull, encrypt } from "@/lib/crypto";
import { MAX_SYNC_FAILURES, SYNC_LEASE_MS, backoffMs } from "@/lib/provider-connections";

/** Cadence for a healthy connection. A floor, never a promise — GitHub cron lags 5-30 min. */
export const CONNECTOR_SYNC_INTERVAL_MS = 30 * 60 * 1000;

export type ClaimedConnectorConnection = {
  id: string;
  userId: string;
  connectorId: string;
  authKind: "oauth2" | "api_key" | "dav_password" | "api_token";
  accountRef: string | null;
  /** Already decrypted. Null means the row is unusable and the caller must flag reauth. */
  accessToken: string | null;
  refreshToken: string | null;
  scopes: string | null;
  capabilities: string[];
  cursor: ConnectorSyncCursor | null;
  syncFailures: number;
};

type ClaimRow = {
  id: string;
  user_id: string;
  connector_id: string;
  auth_kind: ClaimedConnectorConnection["authKind"];
  account_ref: string | null;
  api_key_encrypted: string | null;
  access_token_encrypted: string | null;
  refresh_token_encrypted: string | null;
  scopes: string | null;
  capabilities: string[] | string | null;
  sync_cursor: ConnectorSyncCursor | string | null;
  sync_failures: number;
};

/** PGlite hands back parsed jsonb; `neon-http` can hand back a string. */
function parseJson<T>(value: T | string | null): T | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
}

/**
 * Claim due connections for this run, taking a lease on each.
 *
 * The same predicate as `claimDueConnections` in `provider-connections.ts`: a row is due
 * when it is active, armed, and either idle or holding a lease older than its term.
 */
export async function claimDueConnectorConnections(
  limit: number,
  now: Date = new Date()
): Promise<ClaimedConnectorConnection[]> {
  const db = await getDb();
  const leaseCutoff = new Date(now.getTime() - SYNC_LEASE_MS);
  const rows = rowsOf<ClaimRow>(
    await db.execute(sql`
      UPDATE connector_connections
         SET sync_status = 'syncing', sync_started_at = ${now}, updated_at = ${now}
       WHERE id IN (
         SELECT id FROM connector_connections
          WHERE status = 'active'
            AND next_sync_at IS NOT NULL
            AND next_sync_at <= ${now}
            AND (sync_status IS DISTINCT FROM 'syncing' OR sync_started_at < ${leaseCutoff})
          ORDER BY next_sync_at
          LIMIT ${limit}
       )
      RETURNING id, user_id, connector_id, auth_kind, account_ref, api_key_encrypted,
                access_token_encrypted, refresh_token_encrypted, scopes, capabilities,
                sync_cursor, sync_failures
    `)
  );
  return rows.map((row) => ({
    id: row.id,
    userId: row.user_id,
    connectorId: row.connector_id,
    authKind: row.auth_kind,
    accountRef: row.account_ref,
    accessToken: decryptOrNull(
      row.auth_kind === "oauth2" ? row.access_token_encrypted : row.api_key_encrypted
    ),
    refreshToken: decryptOrNull(row.refresh_token_encrypted),
    scopes: row.scopes,
    capabilities: parseJson<string[]>(row.capabilities) ?? [],
    cursor: parseJson<ConnectorSyncCursor>(row.sync_cursor),
    syncFailures: row.sync_failures,
  }));
}

export type ConnectorSyncOutcome =
  | { ok: true; cursor: ConnectorSyncCursor | null; nextSyncAt?: Date }
  | { ok: false; error: string; retryable: boolean };

/**
 * Record the end of one sync run.
 *
 * A non-retryable failure disarms immediately — it is a consent problem, and retrying a
 * revoked grant on a backoff ladder only delays telling the user.
 */
export async function markConnectorSyncResult(
  id: string,
  outcome: ConnectorSyncOutcome,
  now: Date = new Date()
): Promise<void> {
  const db = await getDb();
  if (outcome.ok) {
    await db
      .update(connectorConnections)
      .set({
        syncCursor: outcome.cursor,
        syncStatus: "idle",
        syncStartedAt: null,
        syncError: null,
        syncFailures: 0,
        lastSyncedAt: now,
        nextSyncAt: outcome.nextSyncAt ?? new Date(now.getTime() + CONNECTOR_SYNC_INTERVAL_MS),
        updatedAt: now,
      })
      .where(eq(connectorConnections.id, id));
    return;
  }

  const [row] = await db
    .select({ failures: connectorConnections.syncFailures })
    .from(connectorConnections)
    .where(eq(connectorConnections.id, id));
  const failures = (row?.failures ?? 0) + 1;
  const error = outcome.error.slice(0, 500);

  if (!outcome.retryable || failures >= MAX_SYNC_FAILURES) {
    await disarmConnectorSync(id, error, now, failures);
    return;
  }

  await db
    .update(connectorConnections)
    .set({
      syncStatus: "error",
      syncStartedAt: null,
      syncError: error,
      syncFailures: failures,
      nextSyncAt: new Date(now.getTime() + backoffMs(failures)),
      updatedAt: now,
    })
    .where(eq(connectorConnections.id, id));
}

/** Stop scheduling this connection. Only reconnecting, or a capability change, re-arms it. */
export async function disarmConnectorSync(
  id: string,
  reason: string,
  now: Date = new Date(),
  failures?: number
): Promise<void> {
  const db = await getDb();
  await db
    .update(connectorConnections)
    .set({
      syncStatus: "error",
      syncStartedAt: null,
      syncError: reason.slice(0, 500),
      ...(failures === undefined ? {} : { syncFailures: failures }),
      nextSyncAt: null,
      updatedAt: now,
    })
    .where(eq(connectorConnections.id, id));
}

/** A token-level rejection: the only way back is re-running the connect flow. */
export async function markConnectorNeedsReauth(id: string, error: string): Promise<void> {
  const db = await getDb();
  await db
    .update(connectorConnections)
    .set({
      status: "needs_reauth",
      syncStatus: "error",
      syncStartedAt: null,
      syncError: error.slice(0, 500),
      nextSyncAt: null,
      updatedAt: new Date(),
    })
    .where(eq(connectorConnections.id, id));
}

export type UpsertConnectorConnectionInput = {
  userId: string;
  connectorId: string;
  authKind: ClaimedConnectorConnection["authKind"];
  label?: string | null;
  accountRef?: string | null;
  /** OAuth access token, API key or app-specific password, encrypted before it is stored. */
  accessToken?: string | null;
  refreshToken?: string | null;
  tokenExpiresAt?: Date | null;
  scopes?: string | null;
  capabilities?: string[];
  nextSyncAt?: Date | null;
};

/**
 * Create or replace the one row for this (user, connector).
 *
 * Reconnecting clears `needs_reauth`, the failure count and the stale error: the grant is
 * new, so none of the old run's state describes it any more.
 */
export async function upsertConnectorConnection(
  input: UpsertConnectorConnectionInput
): Promise<{ id: string }> {
  const db = await getDb();
  const secret = input.accessToken ? encrypt(input.accessToken) : null;
  const values = {
    userId: input.userId,
    connectorId: input.connectorId,
    authKind: input.authKind,
    label: input.label ?? null,
    accountRef: input.accountRef ?? null,
    apiKeyEncrypted: input.authKind === "oauth2" ? null : secret,
    accessTokenEncrypted: input.authKind === "oauth2" ? secret : null,
    refreshTokenEncrypted: input.refreshToken ? encrypt(input.refreshToken) : null,
    tokenExpiresAt: input.tokenExpiresAt ?? null,
    scopes: input.scopes ?? null,
    capabilities: input.capabilities ?? [],
    status: "active" as const,
    syncStatus: "idle" as const,
    syncStartedAt: null,
    syncError: null,
    syncFailures: 0,
    nextSyncAt: input.nextSyncAt ?? new Date(),
    updatedAt: new Date(),
  };
  const [row] = await db
    .insert(connectorConnections)
    .values(values)
    .onConflictDoUpdate({
      target: [connectorConnections.userId, connectorConnections.connectorId],
      // Most OAuth2 providers hand back a refresh token only on first consent, so a later
      // reconnect or token refresh that does not resupply one must not erase the one on
      // file — Task 6's `refreshAccessToken` returns exactly that shape. `label`,
      // `accountRef` and `scopes` follow the same "keep what's stored unless a new value
      // shows up" rule. Mirrors `upsertEventConnection` in `src/lib/events/connections.ts`,
      // which COALESCEs the same four columns against `excluded`.
      set: {
        authKind: sql`excluded.auth_kind`,
        label: sql`coalesce(excluded.label, ${connectorConnections.label})`,
        accountRef: sql`coalesce(excluded.account_ref, ${connectorConnections.accountRef})`,
        // Unconditionally overwritten, not coalesced: a reconnect that supplies a new
        // secret must replace the old one. The auth-kind split in `values` above already
        // nulls out whichever of these two columns no longer applies, so a switch between
        // `api_key` and `oauth2` never leaves a stale secret behind in the other column.
        apiKeyEncrypted: sql`excluded.api_key_encrypted`,
        accessTokenEncrypted: sql`excluded.access_token_encrypted`,
        refreshTokenEncrypted: sql`coalesce(excluded.refresh_token_encrypted, ${connectorConnections.refreshTokenEncrypted})`,
        tokenExpiresAt: sql`excluded.token_expires_at`,
        scopes: sql`coalesce(excluded.scopes, ${connectorConnections.scopes})`,
        capabilities: sql`excluded.capabilities`,
        // Reconnect-clears-stale-state: a fresh grant means none of the old run's error
        // state still describes this row.
        status: values.status,
        syncStatus: values.syncStatus,
        syncStartedAt: values.syncStartedAt,
        syncError: values.syncError,
        syncFailures: values.syncFailures,
        nextSyncAt: sql`excluded.next_sync_at`,
        updatedAt: sql`excluded.updated_at`,
      },
    })
    // Bare `.returning()`, not `.returning({ ... })` — an explicit field selector defeats
    // Drizzle's overload resolution after `.onConflictDoUpdate()` against the union `Db`
    // type (same trap noted in contact-identity.ts, action-items.ts and import-engine.ts).
    .returning();
  return { id: row!.id };
}

export type ConnectorConnectionSummary = {
  id: string;
  connectorId: string;
  label: string | null;
  accountRef: string | null;
  status: "active" | "needs_reauth";
  capabilities: string[];
  lastSyncedAt: Date | null;
  syncError: string | null;
};

/** Never returns a secret: this feeds the settings UI. */
export async function listConnectorConnections(
  userId: string
): Promise<ConnectorConnectionSummary[]> {
  const db = await getDb();
  return db
    .select({
      id: connectorConnections.id,
      connectorId: connectorConnections.connectorId,
      label: connectorConnections.label,
      accountRef: connectorConnections.accountRef,
      status: connectorConnections.status,
      capabilities: connectorConnections.capabilities,
      lastSyncedAt: connectorConnections.lastSyncedAt,
      syncError: connectorConnections.syncError,
    })
    .from(connectorConnections)
    .where(eq(connectorConnections.userId, userId));
}

export async function getConnectorConnection(
  userId: string,
  connectorId: string
): Promise<ConnectorConnectionSummary | null> {
  const all = await listConnectorConnections(userId);
  return all.find((c) => c.connectorId === connectorId) ?? null;
}

/**
 * Turn capabilities on or off.
 *
 * Re-arms the connection, because enabling a capability is exactly when the user expects
 * something to happen — including on a connection a previous failure had disarmed.
 */
export async function setConnectorCapabilities(
  userId: string,
  connectorId: string,
  capabilities: string[]
): Promise<void> {
  const db = await getDb();
  await db
    .update(connectorConnections)
    .set({ capabilities, nextSyncAt: new Date(), updatedAt: new Date() })
    .where(
      and(
        eq(connectorConnections.userId, userId),
        eq(connectorConnections.connectorId, connectorId)
      )
    );
}

export async function deleteConnectorConnection(
  userId: string,
  connectorId: string
): Promise<void> {
  const db = await getDb();
  await db
    .delete(connectorConnections)
    .where(
      and(
        eq(connectorConnections.userId, userId),
        eq(connectorConnections.connectorId, connectorId)
      )
    );
}
