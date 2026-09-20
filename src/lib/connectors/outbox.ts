/**
 * At-least-once write-back to other people's systems.
 *
 * The retry rules are `outbound_webhook_deliveries`': seven attempts on a jittered ladder,
 * then dead. They are restated rather than imported because `webhooks/dispatch.ts` keeps its
 * ladder module-private, and widening that module to share it would be a worse trade than
 * twenty lines of duplication.
 *
 * `deliver` is injected rather than dispatched from the registry here, so this module stays
 * testable without a provider and the connector owns its own HTTP.
 */
import { and, eq, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { connectorOutbox, externalLinks } from "@/db/schema";

/** Attempts before an item is abandoned. Mirrors MAX_DELIVERY_ATTEMPTS in dispatch.ts. */
export const MAX_OUTBOX_ATTEMPTS = 7;

/** Nominal backoff ladder in minutes. The drain runs every ten, so the first steps collapse. */
const BACKOFF_MINUTES = [0.5, 2, 10, 60, 360, 1440];

function backoffFor(attempt: number): number {
  const minutes = BACKOFF_MINUTES[Math.min(attempt, BACKOFF_MINUTES.length - 1)]!;
  // ±20% jitter, so a provider-wide outage does not bring every item back on the same
  // ten-minute boundary once it clears.
  return minutes * (0.8 + Math.random() * 0.4) * 60_000;
}

export type OutboxAction = "writeTask" | "logActivity" | "writeContact";

export type EnqueueOutboxInput = {
  userId: string;
  connectorId: string;
  action: OutboxAction;
  entityType: "reminder" | "interaction" | "contact";
  entityId: string;
  payload: Record<string, unknown>;
};

/**
 * Queue one write. Returns null when this exact action already has a PENDING row queued —
 * that is the only case "idempotent" means here.
 *
 * It deliberately does NOT mean "never do this action again": a `delivered` row means the
 * user is doing this a second time (they re-opened a completed follow-up and completed it
 * again), and a `dead` row means a provider outage burned through every retry, not that the
 * action itself is impossible — reconnecting the connector must be able to re-queue it. Both
 * are revived in place, with the fresh payload, rather than swallowed by the unique index.
 * Only a row that is still `pending` — genuinely not sent yet — is left alone.
 *
 * One statement: `onConflictDoUpdate`'s `setWhere` runs the update conditionally inside the
 * same INSERT, so a `pending` row's WHERE fails, nothing is touched, and RETURNING yields
 * nothing (treated as null below). neon-http has no transactions, so a read-then-write here
 * would race a concurrent enqueue, or the drain's own claim, over the same row.
 */
export async function enqueueOutbox(input: EnqueueOutboxInput): Promise<{ id: string } | null> {
  const db = await getDb();
  const [row] = await db
    .insert(connectorOutbox)
    .values({
      userId: input.userId,
      connectorId: input.connectorId,
      action: input.action,
      entityType: input.entityType,
      entityId: input.entityId,
      payload: input.payload,
      status: "pending",
      nextAttemptAt: new Date(),
    })
    .onConflictDoUpdate({
      target: [
        connectorOutbox.userId,
        connectorOutbox.connectorId,
        connectorOutbox.action,
        connectorOutbox.entityType,
        connectorOutbox.entityId,
      ],
      setWhere: sql`${connectorOutbox.status} <> 'pending'`,
      set: {
        payload: input.payload,
        status: "pending",
        attempts: 0,
        lastError: null,
        deliveredAt: null,
        nextAttemptAt: new Date(),
      },
    })
    .returning();
  return row ? { id: row.id } : null;
}

export type OutboxItem = {
  id: string;
  userId: string;
  connectorId: string;
  action: OutboxAction;
  entityType: string;
  entityId: string;
  payload: Record<string, unknown>;
  attempts: number;
  /** The provider's id from a previous delivery, when there was one. */
  remoteId: string | null;
};

export type DeliverResult =
  | { ok: true; remoteId?: string | null }
  | {
      ok: false;
      error: string;
      /**
       * True (the default when omitted) for anything that might succeed on a later attempt —
       * a timeout, a 5xx, a rate limit. Set false only when NO attempt could ever help: the
       * connector was removed, the write capability is off, the payload itself is rejected.
       * Those items skip the ladder and go straight to `dead` — the honest version of "fail
       * it out rather than retrying forever," which a plain `ok: false` cannot actually do.
       */
      retryable?: boolean;
    };

export type OutboxDrainStats = {
  attempted: number;
  delivered: number;
  failed: number;
  /**
   * A result came back for a row whose lease had already been reclaimed by a later drain
   * (the claim's `attempts` guard on the post-delivery write matched nothing). Not a
   * delivery and not a failure of THIS attempt — the newer owner's outcome is what actually
   * landed. Should be rare (it means a delivery outlived `CLAIM_LEASE_MS`); worth watching if
   * it isn't.
   */
  stale: number;
};

/**
 * Bounds a single delivery call.
 *
 * `dispatch.ts` gives an arbitrary webhook POST 5s. A connector write is a different shape of
 * call — it can need its own token refresh round trip ahead of the actual write — so a 5s
 * bound would false-fail a healthy provider. 15s is generous enough for that while still
 * capping any one hang at well under the drain's 40s working budget, so a single stuck item
 * can never strand the whole run (see IMPORTANT-2 in the v75 review).
 */
const PER_ITEM_DELIVER_TIMEOUT_MS = 15_000;

/**
 * How long a claim reserves a row before another drain may pick it up.
 *
 * Comfortably longer than `PER_ITEM_DELIVER_TIMEOUT_MS` on purpose: the claimed window has to
 * cover the deliver call itself PLUS the claim/lookup round trips that happen before it and
 * the status-update write that happens after it, so the lease outliving just the timeout by a
 * small margin would leave no slack for that overhead. Double the deliver timeout is that
 * margin. See the CAS comment in `drainOutbox` for what this does and does not guarantee.
 *
 * MUST be measured from the moment of the claim itself (`Date.now()` at that point in the
 * loop), never from the drain's own start (`opts.now`/the loop-level `now`). A drain runs for
 * up to `budgetMs` — 40s in production, with up to 200 items — so an item claimed late in a
 * long drain is not "a few ms after now," it can be tens of seconds after it. Anchoring to
 * drain-start leased that item into the PAST the moment it was claimed, making it instantly
 * re-claimable by another drain while still in flight — the exact bug this constant's
 * anchoring point exists to prevent (see NEW-3 in the v75 review).
 */
export const CLAIM_LEASE_MS = 30_000;

/**
 * The minimum remaining budget worth claiming a row for.
 *
 * The claim and the external-link lookup are each a neon-http round trip — reproduced in
 * production at roughly 60-160ms combined. Without a floor, a drain running low on budget
 * would claim a row (burning an attempt via the CAS below), then immediately hand `deliver`
 * a timeout of whatever sliver of budget is left — sometimes 0 — so a perfectly healthy
 * delivery gets charged a failed attempt for a call that was never given a chance to run.
 * 500ms covers that round-trip pair with margin; 1500ms on top is the shortest window a real
 * delivery could plausibly complete in. Below the sum, the item is left for the next drain
 * instead of being claimed and immediately timed out.
 */
const MIN_ROUND_TRIP_BUDGET_MS = 500;
const MIN_DELIVER_WINDOW_MS = 1_500;
const ITEM_BUDGET_FLOOR_MS = MIN_ROUND_TRIP_BUDGET_MS + MIN_DELIVER_WINDOW_MS;

/**
 * Races `deliver` against a timeout and reports a timeout as an ordinary failed attempt —
 * never a throw, never a hang. This bounds how long the CALLER waits; it cannot cancel
 * whatever `deliver` is actually doing underneath (no AbortSignal crosses this boundary,
 * because `deliver` is caller-injected and P0 has no real implementation to hand one to).
 * A real P2 `deliver` should still apply its own request timeout internally for that reason.
 */
function withTimeout(promise: Promise<DeliverResult>, ms: number): Promise<DeliverResult> {
  return new Promise((resolve) => {
    const timer = setTimeout(
      () => resolve({ ok: false, error: `Delivery timed out after ${ms}ms` }),
      ms
    );
    promise.then(
      (result) => {
        clearTimeout(timer);
        resolve(result);
      },
      (err: unknown) => {
        clearTimeout(timer);
        resolve({ ok: false, error: err instanceof Error ? err.message : String(err) });
      }
    );
  });
}

export async function drainOutbox(opts: {
  budgetMs: number;
  max: number;
  now?: Date;
  deliver: (item: OutboxItem) => Promise<DeliverResult>;
}): Promise<OutboxDrainStats> {
  const now = opts.now ?? new Date();
  const deadline = Date.now() + opts.budgetMs;
  const stats: OutboxDrainStats = { attempted: 0, delivered: 0, failed: 0, stale: 0 };
  const db = await getDb();

  const due = await db
    .select()
    .from(connectorOutbox)
    .where(
      and(
        eq(connectorOutbox.status, "pending"),
        sql`${connectorOutbox.nextAttemptAt} IS NOT NULL`,
        sql`${connectorOutbox.nextAttemptAt} <= ${now}`
      )
    )
    .orderBy(connectorOutbox.nextAttemptAt)
    .limit(opts.max);

  for (const row of due) {
    // Not just "is there any budget left" — is there enough left to be worth claiming this
    // row for. Claiming and then immediately handing `deliver` a near-zero timeout charges a
    // perfectly healthy item a failed attempt for a call that never ran; better to leave it
    // untouched for the next drain than to burn its attempts count on a starved timeout.
    if (deadline - Date.now() < ITEM_BUDGET_FLOOR_MS) break;

    // Claim-with-lease. A manual curl racing the ten-minute cron (ops.yml's
    // `cancel-in-progress: false` only keeps two SCHEDULED runs from overlapping) — or any
    // two drains staggered by more than a few hundred ms — can both consider this row due.
    // The `attempts` guard alone only stops two callers that read the SAME stale snapshot;
    // it does NOT stop a second drain that runs its own SELECT after this UPDATE has already
    // committed, because that second SELECT sees the fresh, post-claim `attempts` value and
    // its CAS succeeds against it. Pushing `nextAttemptAt` out to `Date.now() + CLAIM_LEASE_MS`
    // in this SAME statement is what closes that gap: a claimed row no longer matches the
    // `due` query's `nextAttemptAt <= now` filter at all, for any drain, until the lease
    // expires or the delivery below overwrites `nextAttemptAt` on success or failure (both
    // paths do, unconditionally, guarded against a stale write below). This is a lease, not a
    // lock: if a delivery somehow outlives the lease (it shouldn't — the lease is double
    // `PER_ITEM_DELIVER_TIMEOUT_MS`), a later drain can still claim and redeliver it.
    // At-least-once semantics, not exactly-once — stated plainly because that is the true
    // guarantee, not "this can never double-send."
    //
    // The lease is anchored at `Date.now()` HERE, not at the loop-level `now` (the drain's
    // own start, or `opts.now` when a caller injects one for determinism). A drain can run
    // for the whole `budgetMs` — up to 200 items over 40s in production — so an item claimed
    // late is not "a few ms after `now`," and leasing it from drain-start would put its
    // expiry in the past the moment it was claimed. `opts.now` still governs which rows count
    // as due (the `due` query above) and the bookkeeping timestamps below; only the
    // correctness-critical scheduling — this lease and the failure path's backoff — reads the
    // real clock instead.
    const [claimed] = await db
      .update(connectorOutbox)
      .set({
        attempts: row.attempts + 1,
        lastAttemptedAt: now,
        nextAttemptAt: new Date(Date.now() + CLAIM_LEASE_MS),
      })
      .where(
        and(
          eq(connectorOutbox.id, row.id),
          eq(connectorOutbox.status, "pending"),
          eq(connectorOutbox.attempts, row.attempts)
        )
      )
      .returning();
    if (!claimed) continue;

    stats.attempted++;
    const link = await findExternalLink(row.userId, row.connectorId, row.entityType, row.entityId);
    // One connector's failure — or a hung one — must never stop the queue. The timeout below
    // is what makes a hang true: without it, a stalled provider could eat the whole drain
    // budget, the route would hit `maxDuration` and be killed before `finishCronRun` ran
    // (stranding a `running` cron_runs row), and — because the claim above already bumped
    // `attempts` — this item would still age normally even though this drain never got an
    // answer, rather than sitting at `attempts: 0` retrying forever.
    const remainingMs = Math.max(0, deadline - Date.now());
    const result = await withTimeout(
      opts.deliver({
        id: row.id,
        userId: row.userId,
        connectorId: row.connectorId,
        action: row.action as OutboxAction,
        entityType: row.entityType,
        entityId: row.entityId,
        payload: row.payload as Record<string, unknown>,
        attempts: claimed.attempts,
        remoteId: link?.remoteId ?? null,
      }),
      Math.min(PER_ITEM_DELIVER_TIMEOUT_MS, remainingMs)
    );

    if (result.ok) {
      // Guarded on `attempts` still matching what THIS drain claimed with, the same CAS
      // shape as the claim itself. Keyed on `id` alone (as this was before), a delivery that
      // outlives its lease (NEW-3: possible, just meant to be rare) would land here after a
      // later drain has already reclaimed — and possibly already resolved — the row, and
      // silently stomp whatever that newer owner decided. Zero rows affected means exactly
      // that happened; counted as `stale`, not `delivered`, because this drain's result is
      // not the one that should stand.
      const [updated] = await db
        .update(connectorOutbox)
        .set({
          status: "delivered",
          lastAttemptedAt: now,
          deliveredAt: now,
          nextAttemptAt: null,
          lastError: null,
        })
        .where(
          and(eq(connectorOutbox.id, row.id), eq(connectorOutbox.attempts, claimed.attempts))
        )
        .returning();
      if (!updated) {
        stats.stale++;
        continue;
      }
      stats.delivered++;
      // Only recorded once this drain's write is confirmed to have won — recording it
      // first (as before) risked a stale drain overwriting `external_links` with an older
      // `remoteId` after a newer delivery had already recorded its own.
      if (result.remoteId) {
        await recordExternalLink({
          userId: row.userId,
          connectorId: row.connectorId,
          entityType: row.entityType,
          entityId: row.entityId,
          remoteId: result.remoteId,
        });
      }
      continue;
    }

    // `attempts` was already bumped by the claim above — that IS this attempt, so the
    // exhaustion check reads it rather than re-deriving it. A `retryable: false` result
    // (the connector is gone, the write capability is off) skips the ladder entirely: no
    // future attempt could do anything different, so waiting seven rounds to reach the same
    // `dead` would only delay the truth.
    const exhausted = result.retryable === false || claimed.attempts >= MAX_OUTBOX_ATTEMPTS;
    // Same attempts guard and the same reason: a failure result arriving after this row's
    // lease was reclaimed must not overwrite the newer owner's outcome either — a stale
    // failure clobbering a legitimate `delivered` is the harmful direction of this bug.
    const [updatedFailure] = await db
      .update(connectorOutbox)
      .set({
        status: exhausted ? "dead" : "pending",
        lastError: result.error.slice(0, 200),
        lastAttemptedAt: now,
        nextAttemptAt: exhausted ? null : new Date(Date.now() + backoffFor(claimed.attempts)),
      })
      .where(
        and(eq(connectorOutbox.id, row.id), eq(connectorOutbox.attempts, claimed.attempts))
      )
      .returning();
    if (updatedFailure) {
      stats.failed++;
    } else {
      stats.stale++;
    }
  }

  return stats;
}

export async function recordExternalLink(input: {
  userId: string;
  connectorId: string;
  entityType: string;
  entityId: string;
  remoteId: string;
}): Promise<void> {
  const db = await getDb();
  await db
    .insert(externalLinks)
    .values({ ...input, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: [
        externalLinks.userId,
        externalLinks.connectorId,
        externalLinks.entityType,
        externalLinks.entityId,
      ],
      set: { remoteId: input.remoteId, updatedAt: new Date() },
    });
}

export async function findExternalLink(
  userId: string,
  connectorId: string,
  entityType: string,
  entityId: string
): Promise<{ remoteId: string } | null> {
  const db = await getDb();
  const [row] = await db
    .select({ remoteId: externalLinks.remoteId })
    .from(externalLinks)
    .where(
      and(
        eq(externalLinks.userId, userId),
        eq(externalLinks.connectorId, connectorId),
        eq(externalLinks.entityType, entityType),
        eq(externalLinks.entityId, entityId)
      )
    );
  return row ?? null;
}
