/**
 * Storing and scheduling the Luma / Eventbrite connections.
 *
 * ## Why this does not just add an entry to `PROVIDER_TABLES`
 *
 * `src/lib/provider-connections.ts` says a third provider is "a new table plus one entry in
 * `PROVIDER_TABLES`". That presumes byte-identity with the Gmail/Outlook tables, and this one
 * is not: `claimDueConnections` hard-codes `RETURNING ... email_address ...` and its
 * `ClaimedConnection` type requires `emailAddress: string`. An event connection has no email
 * address, and it does have `provider` / `auth_kind` / `api_key_encrypted` that those rows
 * do not.
 *
 * Widening the shared claim to carry a nullable email and three extra columns would make
 * every Gmail sync pay for fields it never reads, so this is a sibling instead — but it
 * IMPORTS the lease term, the failure ceiling and the backoff curve rather than restating
 * them. Those three are the parts that must not drift; the SQL around them can differ.
 *
 * No `next/*` imports — the sync scheduler and smoke scripts both load this.
 */
import { sql } from "drizzle-orm";
import { getDb, rowsOf } from "@/db";
import { encrypt, decryptOrNull } from "@/lib/crypto";
import {
  MAX_SYNC_FAILURES,
  SYNC_LEASE_MS,
  backoffMs,
} from "@/lib/provider-connections";
import type { EventProviderSyncCursor } from "@/db/schema";
import type { EventProviderId } from "@/lib/events/types";

/** Matches the Gmail/Outlook cadence. The GitHub Actions cron runs every 15 minutes anyway. */
export const EVENT_SYNC_INTERVAL_MS = 30 * 60 * 1000;

export type ClaimedEventConnection = {
  id: string;
  userId: string;
  provider: EventProviderId;
  authKind: "api_key" | "oauth";
  accountRef: string | null;
  /** Already decrypted. Null means the row is unusable and the caller must flag reauth. */
  secret: string | null;
  cursor: EventProviderSyncCursor | null;
  syncFailures: number;
};

type ClaimRow = {
  id: string;
  user_id: string;
  provider: EventProviderId;
  auth_kind: "api_key" | "oauth";
  account_ref: string | null;
  api_key_encrypted: string | null;
  access_token_encrypted: string | null;
  sync_cursor: unknown;
  sync_failures: number | string;
};

function parseCursor(raw: unknown): EventProviderSyncCursor | null {
  if (!raw) return null;
  if (typeof raw === "string") {
    try {
      return JSON.parse(raw) as EventProviderSyncCursor;
    } catch {
      return null;
    }
  }
  return raw as EventProviderSyncCursor;
}

/**
 * Claim due connections under a lease.
 *
 * The `sync_started_at < leaseCutoff` half is load-bearing and copied deliberately: without
 * it, `sync_status = 'syncing'` latches forever the first time an invocation is killed
 * mid-run, and the connection is never swept again.
 */
export async function claimDueEventConnections(
  limit: number,
  now: Date = new Date()
): Promise<ClaimedEventConnection[]> {
  const db = await getDb();
  const leaseCutoff = new Date(now.getTime() - SYNC_LEASE_MS);

  const claimed = await db.execute(sql`
    UPDATE event_provider_connections
       SET sync_status = 'syncing', sync_started_at = ${now}, updated_at = ${now}
     WHERE id IN (
       SELECT id FROM event_provider_connections
        WHERE status = 'active'
          AND next_sync_at IS NOT NULL
          AND next_sync_at <= ${now}
          AND (sync_status IS DISTINCT FROM 'syncing' OR sync_started_at < ${leaseCutoff})
        ORDER BY next_sync_at
        LIMIT ${limit}
     )
    RETURNING id, user_id, provider, auth_kind, account_ref,
              api_key_encrypted, access_token_encrypted, sync_cursor, sync_failures
  `);

  return rowsOf<ClaimRow>(claimed).map((row) => ({
    id: row.id,
    userId: row.user_id,
    provider: row.provider,
    authKind: row.auth_kind,
    accountRef: row.account_ref,
    secret: decryptOrNull(
      row.auth_kind === "api_key" ? row.api_key_encrypted : row.access_token_encrypted
    ),
    cursor: parseCursor(row.sync_cursor),
    syncFailures: Number(row.sync_failures ?? 0),
  }));
}

export type EventSyncOutcome =
  | { ok: true; cursor: EventProviderSyncCursor | null }
  | { ok: false; error: string; retryable: boolean };

/** Record one run's result and schedule (or disarm) the next. Mirrors `markSyncResult`. */
export async function markEventSyncResult(
  id: string,
  outcome: EventSyncOutcome,
  now: Date = new Date()
): Promise<void> {
  const db = await getDb();

  if (outcome.ok) {
    await db.execute(sql`
      UPDATE event_provider_connections
         SET sync_status = 'idle',
             sync_started_at = NULL,
             sync_error = NULL,
             sync_failures = 0,
             sync_cursor = ${outcome.cursor === null ? null : JSON.stringify(outcome.cursor)}::jsonb,
             next_sync_at = ${new Date(now.getTime() + EVENT_SYNC_INTERVAL_MS)},
             last_synced_at = ${now},
             updated_at = ${now}
       WHERE id = ${id}
    `);
    return;
  }

  // Truncated like every other error column here: a provider can return a whole HTML page.
  const message = outcome.error.slice(0, 500);
  if (!outcome.retryable) {
    await disarmEventSync(id, message, now);
    return;
  }

  // Read-modify-write on a row this run holds the lease for, so the increment cannot race.
  const current = rowsOf<{ sync_failures: number }>(
    await db.execute(sql`SELECT sync_failures FROM event_provider_connections WHERE id = ${id}`)
  )[0];
  const failures = Number(current?.sync_failures ?? 0) + 1;

  if (failures >= MAX_SYNC_FAILURES) {
    await disarmEventSync(id, message, now, failures);
    return;
  }

  await db.execute(sql`
    UPDATE event_provider_connections
       SET sync_status = 'error',
           sync_started_at = NULL,
           sync_error = ${message},
           sync_failures = ${failures},
           next_sync_at = ${new Date(now.getTime() + backoffMs(failures))},
           updated_at = ${now}
     WHERE id = ${id}
  `);
}

/**
 * Stop sweeping this connection.
 *
 * `next_sync_at = NULL` is the whole mechanism — the claim predicate requires it to be
 * non-null, so a disarmed row is invisible to the scheduler until reconnecting re-arms it.
 * An auth failure also flips `status` so the UI can say "reconnect" rather than "we gave up".
 */
export async function disarmEventSync(
  id: string,
  error: string,
  now: Date = new Date(),
  failures?: number
): Promise<void> {
  const db = await getDb();
  await db.execute(sql`
    UPDATE event_provider_connections
       SET sync_status = 'error',
           sync_started_at = NULL,
           sync_error = ${error.slice(0, 500)},
           sync_failures = ${failures ?? MAX_SYNC_FAILURES},
           next_sync_at = NULL,
           updated_at = ${now}
     WHERE id = ${id}
  `);
}

export async function markNeedsReauth(id: string, error: string): Promise<void> {
  const db = await getDb();
  await db.execute(sql`
    UPDATE event_provider_connections
       SET status = 'needs_reauth', sync_status = 'error', sync_started_at = NULL,
           sync_error = ${error.slice(0, 500)}, next_sync_at = NULL, updated_at = now()
     WHERE id = ${id}
  `);
}

export type EventConnectionSummary = {
  id: string;
  provider: EventProviderId;
  label: string | null;
  status: "active" | "needs_reauth";
  lastSyncedAt: Date | null;
  syncError: string | null;
};

export async function listEventConnections(userId: string): Promise<EventConnectionSummary[]> {
  const db = await getDb();
  const rows = rowsOf<{
    id: string;
    provider: EventProviderId;
    label: string | null;
    status: "active" | "needs_reauth";
    last_synced_at: string | Date | null;
    sync_error: string | null;
  }>(
    await db.execute(sql`
      SELECT id, provider, label, status, last_synced_at, sync_error
        FROM event_provider_connections
       WHERE user_id = ${userId}
       ORDER BY provider
    `)
  );
  return rows.map((r) => ({
    id: r.id,
    provider: r.provider,
    label: r.label,
    status: r.status,
    lastSyncedAt: r.last_synced_at ? new Date(r.last_synced_at) : null,
    syncError: r.sync_error,
  }));
}

/**
 * Create or replace a connection.
 *
 * `next_sync_at = now()` on every upsert is what re-arms a connection that had been disarmed:
 * reconnecting is the one action that says "this credential is good again", so it must clear
 * the failure count and put the row back in front of the scheduler.
 */
export async function upsertEventConnection(
  userId: string,
  input: {
    provider: EventProviderId;
    authKind: "api_key" | "oauth";
    secret: string;
    refreshToken?: string | null;
    tokenExpiresAt?: Date | null;
    scopes?: string | null;
    label?: string | null;
    accountRef?: string | null;
  }
): Promise<void> {
  const db = await getDb();
  const encrypted = encrypt(input.secret);
  const apiKey = input.authKind === "api_key" ? encrypted : null;
  const accessToken = input.authKind === "oauth" ? encrypted : null;
  const refresh = input.refreshToken ? encrypt(input.refreshToken) : null;

  await db.execute(sql`
    INSERT INTO event_provider_connections
      (user_id, provider, auth_kind, label, account_ref, api_key_encrypted,
       access_token_encrypted, refresh_token_encrypted, token_expires_at, scopes,
       status, next_sync_at, sync_failures)
    VALUES
      (${userId}, ${input.provider}, ${input.authKind}, ${input.label ?? null},
       ${input.accountRef ?? null}, ${apiKey}, ${accessToken}, ${refresh},
       ${input.tokenExpiresAt ?? null}, ${input.scopes ?? null}, 'active', now(), 0)
    ON CONFLICT (user_id, provider) DO UPDATE SET
      auth_kind = excluded.auth_kind,
      label = COALESCE(excluded.label, event_provider_connections.label),
      account_ref = COALESCE(excluded.account_ref, event_provider_connections.account_ref),
      api_key_encrypted = excluded.api_key_encrypted,
      access_token_encrypted = excluded.access_token_encrypted,
      refresh_token_encrypted = COALESCE(excluded.refresh_token_encrypted,
                                         event_provider_connections.refresh_token_encrypted),
      token_expires_at = excluded.token_expires_at,
      scopes = COALESCE(excluded.scopes, event_provider_connections.scopes),
      status = 'active',
      sync_status = NULL,
      sync_error = NULL,
      sync_failures = 0,
      next_sync_at = now(),
      updated_at = now()
  `);
}

/** Disconnecting deletes the row — the same rule the Gmail/Outlook tables follow. */
export async function deleteEventConnection(
  userId: string,
  provider: EventProviderId
): Promise<void> {
  const db = await getDb();
  await db.execute(sql`
    DELETE FROM event_provider_connections WHERE user_id = ${userId} AND provider = ${provider}
  `);
}
