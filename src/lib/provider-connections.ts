/**
 * The one place that treats Gmail and Outlook connections polymorphically.
 *
 * `gmail_connections` and `outlook_connections` are byte-identical tables with different
 * names — a historical accident of Outlook being added by copying the Gmail module. The
 * obvious fix is one `provider_connections` table with a discriminator, and it was
 * considered and rejected: the two names are read directly in `gmail.ts`, `outlook.ts`,
 * `closeness-cohort.ts`, `admin-system.ts`, `actions/imports.ts` and both callback routes,
 * migrations here are hand-written idempotent DDL with no transactions on `neon-http` and no
 * down-migrations, and the `DROP TABLE` that ends such a migration is a one-way door that
 * breaks any deploy rolled back past it. That risk buys nothing a lookup map does not.
 *
 * So: new code goes through this module and never names a table. A third provider is a new
 * table plus one entry in `PROVIDER_TABLES`. If the unified table ever becomes worth it,
 * this file is the only thing that has to change.
 *
 * Deliberately free of `next/server` and `next/cache` imports — `internal-auth.ts` and
 * `cron-runs.ts` both record that importing `next/server` alone retains the Node event loop
 * and hangs any `tsx` script. The sync scheduler and its smoke tests both load this.
 */
import { sql } from "drizzle-orm";
import { getDb, rowsOf } from "@/db";
import type { ProviderSyncCursor } from "@/db/schema";

export type SyncProvider = "google" | "microsoft";

/**
 * Table name per provider. A plain string map rather than Drizzle table objects because
 * every statement below is raw SQL: the claim needs `UPDATE ... WHERE id IN (SELECT ...)`,
 * which the query builder cannot express, and mixing the two styles for one concern reads
 * worse than committing to one.
 *
 * Values are interpolated with `sql.raw`, so they must never come from user input. They are
 * literals in this map and nothing else may add to it at runtime.
 */
const PROVIDER_TABLES: Record<SyncProvider, string> = {
  google: "gmail_connections",
  microsoft: "outlook_connections",
};

export const SYNC_PROVIDERS = Object.keys(PROVIDER_TABLES) as SyncProvider[];

/**
 * How long a claim is honoured before another run may take the row.
 *
 * This is what stops `sync_status = 'syncing'` from latching forever the first time an
 * invocation is killed mid-run — the same failure `cron-runs.ts` resolves on read for its
 * own `running` rows. Comfortably longer than the 300s function ceiling, so a run that is
 * merely slow is never stolen from.
 */
export const SYNC_LEASE_MS = 10 * 60 * 1000;

/** Give up after this many consecutive failures. Mirrors `MAX_STALL_RESUMES` in import-stall.ts. */
export const MAX_SYNC_FAILURES = 6;

export type ClaimedConnection = {
  provider: SyncProvider;
  id: string;
  userId: string;
  emailAddress: string;
  scopes: string | null;
  syncCursor: ProviderSyncCursor | null;
  syncFailures: number;
};

type ClaimRow = {
  id: string;
  user_id: string;
  email_address: string;
  scopes: string | null;
  sync_cursor: ProviderSyncCursor | string | null;
  sync_failures: number;
};

/** PGlite hands back parsed jsonb; `neon-http` can hand back a string. */
function parseCursor(value: ProviderSyncCursor | string | null): ProviderSyncCursor | null {
  if (value == null) return null;
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value) as ProviderSyncCursor;
  } catch {
    return null;
  }
}

/**
 * Claim up to `limit` connections that are due, marking them in the same statement that
 * reads them.
 *
 * Safe without a transaction, which `neon-http` does not offer. It is a single statement, so
 * it takes its row locks atomically; a second scheduler blocking on the same row re-evaluates
 * the predicate against the updated row under READ COMMITTED and skips it. That is the same
 * argument `runImportJob`'s row claim makes, and the reason the lease clause is part of the
 * predicate rather than a separate reaper: an abandoned claim becomes due again on its own.
 *
 * Note `UPDATE ... RETURNING` does not promise output in the subquery's `ORDER BY` order.
 * Irrelevant while per-connection work is independent — but do not add an order-dependent
 * step downstream without fixing that here first.
 */
export async function claimDueConnections(
  provider: SyncProvider,
  limit: number,
  now: Date = new Date()
): Promise<ClaimedConnection[]> {
  const db = await getDb();
  const table = sql.raw(PROVIDER_TABLES[provider]);
  const leaseCutoff = new Date(now.getTime() - SYNC_LEASE_MS);

  const claimed = await db.execute(sql`
    UPDATE ${table}
       SET sync_status = 'syncing', sync_started_at = ${now}, updated_at = ${now}
     WHERE id IN (
       SELECT id FROM ${table}
        WHERE status = 'active'
          AND next_sync_at IS NOT NULL
          AND next_sync_at <= ${now}
          AND (sync_status IS DISTINCT FROM 'syncing' OR sync_started_at < ${leaseCutoff})
        ORDER BY next_sync_at
        LIMIT ${limit}
     )
    RETURNING id, user_id, email_address, scopes, sync_cursor, sync_failures
  `);

  return rowsOf<ClaimRow>(claimed).map((row) => ({
    provider,
    id: row.id,
    userId: row.user_id,
    emailAddress: row.email_address,
    scopes: row.scopes,
    syncCursor: parseCursor(row.sync_cursor),
    syncFailures: Number(row.sync_failures ?? 0),
  }));
}

export type SyncOutcome =
  | { ok: true; cursor: ProviderSyncCursor | null; nextSyncAt: Date }
  /**
   * `retryable: false` disarms immediately rather than burning the backoff ladder — for a
   * fault no amount of waiting fixes, such as a revoked scope.
   */
  | { ok: false; error: string; retryable: boolean };

/**
 * Exponential backoff, capped at a day: 1h, 2h, 4h, 8h, 16h, 24h.
 *
 * Jittered by ±20% so a provider-wide outage does not bring every connection back on the
 * same boundary once it clears.
 */
export function backoffMs(failures: number): number {
  const hours = Math.min(2 ** Math.max(0, failures - 1), 24);
  const base = hours * 60 * 60 * 1000;
  return Math.round(base * (0.8 + Math.random() * 0.4));
}

/** Records the result of one connection's run and schedules (or disarms) the next. */
export async function markSyncResult(
  provider: SyncProvider,
  id: string,
  outcome: SyncOutcome,
  now: Date = new Date()
): Promise<void> {
  const db = await getDb();
  const table = sql.raw(PROVIDER_TABLES[provider]);

  if (outcome.ok) {
    await db.execute(sql`
      UPDATE ${table}
         SET sync_status = 'idle',
             sync_started_at = NULL,
             sync_error = NULL,
             sync_failures = 0,
             sync_cursor = ${outcome.cursor === null ? null : JSON.stringify(outcome.cursor)}::jsonb,
             next_sync_at = ${outcome.nextSyncAt},
             last_synced_at = ${now},
             updated_at = ${now}
       WHERE id = ${id}
    `);
    return;
  }

  // Truncated like every other error column here: a provider can return a whole HTML page.
  const message = outcome.error.slice(0, 500);

  if (!outcome.retryable) {
    await disarmSync(provider, id, message, now);
    return;
  }

  // Read-modify-write on a row this run holds the lease for, so the increment cannot race.
  const current = rowsOf<{ sync_failures: number }>(
    await db.execute(sql`SELECT sync_failures FROM ${table} WHERE id = ${id}`)
  )[0];
  const failures = Number(current?.sync_failures ?? 0) + 1;

  if (failures >= MAX_SYNC_FAILURES) {
    await disarmSync(provider, id, message, now, failures);
    return;
  }

  await db.execute(sql`
    UPDATE ${table}
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
 * Stops sweeping this connection. `next_sync_at = NULL` is the whole mechanism — the claim
 * predicate requires it to be non-null, so a disarmed row is invisible to the scheduler
 * until something deliberately re-arms it (reconnecting, which `upsert*Connection` handles).
 *
 * Note this leaves `status` alone: the grant may still be perfectly valid. Only a token-level
 * rejection may write `needs_reauth`, and that decision belongs to `getValidAccessToken`.
 */
export async function disarmSync(
  provider: SyncProvider,
  id: string,
  reason: string,
  now: Date = new Date(),
  failures?: number
): Promise<void> {
  const db = await getDb();
  const table = sql.raw(PROVIDER_TABLES[provider]);
  await db.execute(sql`
    UPDATE ${table}
       SET sync_status = 'error',
           sync_started_at = NULL,
           sync_error = ${reason.slice(0, 500)},
           next_sync_at = NULL,
           ${failures === undefined ? sql`` : sql`sync_failures = ${failures},`}
           updated_at = ${now}
     WHERE id = ${id}
  `);
}

/**
 * Which kinds of connected source could plausibly have seen this user's contacts.
 *
 * Feeds `coveredByConnectedSource` in the closeness evidence model, which is why the bar is
 * "has actually synced" rather than "a row exists". Coverage is a claim that Orbit could have
 * observed this person; a connection that has never completed a sync has observed nobody, and
 * counting it would hand out evidence nothing earned.
 */
export async function loadCoverageSources(
  userId: string
): Promise<{ mailConnected: boolean; calendarConnected: boolean }> {
  const db = await getDb();
  const result = await db.execute(sql`
    SELECT
      EXISTS (
        SELECT 1 FROM gmail_connections
         WHERE user_id = ${userId} AND status = 'active'
      ) OR EXISTS (
        SELECT 1 FROM outlook_connections
         WHERE user_id = ${userId} AND status = 'active'
      ) AS mail_connected,
      EXISTS (
        SELECT 1 FROM gmail_connections
         WHERE user_id = ${userId} AND status = 'active'
           AND last_synced_at IS NOT NULL
           AND scopes LIKE '%calendar.readonly%'
      ) OR EXISTS (
        SELECT 1 FROM calendar_subscriptions
         WHERE user_id = ${userId} AND enabled = 1 AND last_sync_status = 'ok'
      ) AS calendar_connected
  `);
  const row = rowsOf<{ mail_connected: boolean; calendar_connected: boolean }>(result)[0];
  return {
    mailConnected: Boolean(row?.mail_connected),
    calendarConnected: Boolean(row?.calendar_connected),
  };
}
