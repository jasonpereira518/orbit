/**
 * What a connected account's first sync looks like from the outside.
 *
 * Onboarding connects an account and then has nothing to say for as long as the first sync
 * takes; this is the read that lets it say "found 214 people" instead. It reports on the
 * three continuously-synced providers (Google, Microsoft, Apple) from state the scheduler
 * already writes — no new columns, no new table.
 */
import { and, eq, inArray, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { appleConnections, contacts, gmailConnections, outlookConnections } from "@/db/schema";

export type SyncProviderId = "google" | "microsoft" | "apple";

export type SyncProgressState =
  /** Armed and waiting for the scheduler; nothing has run yet. */
  | "queued"
  /** A run holds the lease, or the last run ran out of budget and more is waiting. */
  | "syncing"
  /** The last run finished everything it was asked for. */
  | "done"
  /** The grant is dead or the run is failing; the person has to act or wait out a retry. */
  | "error"
  /** The person switched meetings off. */
  | "paused";

export type SyncProgress = {
  provider: SyncProviderId;
  state: SyncProgressState;
  /** Contacts this provider's sync has created. */
  peopleFound: number;
  /** People the plan's contact cap held back, at least — 0 when none are waiting. */
  peopleWaiting: number;
  lastSyncedAt: Date | null;
  error: string | null;
};

/** The columns of a connection row this derivation reads. */
export type SyncRowState = {
  status: string | null;
  /** The connection's `sync_cursor` jsonb; only `contacts.blockedByPlan` is read from it. */
  syncCursor?: { contacts?: { blockedByPlan?: number | null } | null } | null;
  syncStatus: "idle" | "syncing" | "error" | "paused" | null;
  lastSyncedAt: Date | null;
  nextSyncAt: Date | null;
  syncError: string | null;
};

/**
 * Pure: a connection row's state, with no I/O so every branch is testable.
 *
 * "Done" is the subtle one. A run that finished its work schedules the next one a sync
 * interval ahead; a run that ran out of budget mid-book schedules the next for the moment it
 * STARTED (`nextSyncAt = now`), which is earlier than the `lastSyncedAt` it stamps on the way
 * out. So `nextSyncAt > lastSyncedAt` means finished, and anything else means more is waiting.
 * A row with no `nextSyncAt` at all is disarmed — failure, not completion.
 */
export function deriveSyncState(row: SyncRowState): SyncProgressState {
  if (row.syncStatus === "paused") return "paused";
  if (row.status && row.status !== "active") return "error";
  if (row.syncStatus === "syncing") return "syncing";
  if (row.syncStatus === "error") return "error";
  if (!row.lastSyncedAt) return row.nextSyncAt ? "queued" : "error";
  if (!row.nextSyncAt) return "error";
  return row.nextSyncAt.getTime() > row.lastSyncedAt.getTime() ? "done" : "syncing";
}

/** `contacts.source` values each provider's sync writes (see `sync-scheduler.ts`). */
export const PROVIDER_CONTACT_SOURCES: Record<SyncProviderId, string[]> = {
  google: ["google_contacts", "google_calendar"],
  microsoft: ["microsoft_calendar"],
  apple: ["apple_calendar"],
};

/** One entry per provider the user has connected, in a stable order. */
export async function getSyncProgress(userId: string): Promise<SyncProgress[]> {
  const db = await getDb();

  const [google, microsoft, apple] = await Promise.all([
    db.query.gmailConnections.findFirst({ where: eq(gmailConnections.userId, userId) }),
    db.query.outlookConnections.findFirst({ where: eq(outlookConnections.userId, userId) }),
    db.query.appleConnections.findFirst({ where: eq(appleConnections.userId, userId) }),
  ]);
  const connected: Array<[SyncProviderId, SyncRowState]> = [];
  if (google) connected.push(["google", google]);
  if (microsoft) connected.push(["microsoft", microsoft]);
  if (apple) connected.push(["apple", apple]);
  if (connected.length === 0) return [];

  const allSources = connected.flatMap(([provider]) => PROVIDER_CONTACT_SOURCES[provider]);
  const counts = await db
    .select({ source: contacts.source, n: sql<number>`count(*)::int` })
    .from(contacts)
    .where(and(eq(contacts.userId, userId), inArray(contacts.source, allSources)))
    .groupBy(contacts.source);
  const bySource = new Map(counts.map((c) => [c.source, Number(c.n)]));

  return connected.map(([provider, row]) => ({
    provider,
    state: deriveSyncState(row),
    peopleFound: PROVIDER_CONTACT_SOURCES[provider].reduce(
      (sum, source) => sum + (bySource.get(source) ?? 0),
      0
    ),
    peopleWaiting: row.syncCursor?.contacts?.blockedByPlan ?? 0,
    lastSyncedAt: row.lastSyncedAt,
    error: row.syncError,
  }));
}
