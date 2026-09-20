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
 *
 * ── Why the claim looks the way it does ─────────────────────────────────────────────────
 *
 * Three rounds of fixes to this file each closed a reproduced double-delivery and opened the
 * next one, because the mutual exclusion was spread across columns that were also doing other
 * jobs: `next_attempt_at` was the retry schedule AND the lease AND the lock, `attempts` was
 * the retry counter AND the compare-and-swap token AND a user-visible stat, and the drain's
 * `now` was a test seam AND a scheduling input. The last failure was the clearest: a token
 * made of `attempts` is subject to ABA, because `enqueueOutbox` legitimately resets
 * `attempts` to 0 when it revives a row — so a stale owner's token recurred and its ancient
 * failure landed on a live, in-flight row.
 *
 * So ownership now has its own two columns and nothing else touches them:
 *
 *   - `claimed_by`    a fresh uuid per claim. An IDENTITY, not a counter — no business rule
 *                     can make one recur, so ABA is not representable.
 *   - `claimed_until` when that claim lapses, always computed from the DATABASE's `now()`.
 *
 * and three rules hold everywhere below:
 *
 *   1. One statement claims and locks. `UPDATE ... WHERE id = (SELECT ... FOR UPDATE SKIP
 *      LOCKED LIMIT 1) RETURNING *` selects, locks, stamps and returns the row in a single
 *      round trip — so neon-http's lack of transactions is irrelevant, because there is
 *      nothing to wrap. PGlite runs the statement (SKIP LOCKED included) fine, verified by
 *      running it rather than assumed — but PGlite is one in-process backend that serializes
 *      every query, so no two sessions there ever contend for a row lock and `SKIP LOCKED` is
 *      unobservable locally. Removing it does not fail the smoke suite, and cannot. It earns
 *      its place on Neon, where each statement is its own session: without it a losing
 *      claimer blocks on the winner's row lock for the length of that UPDATE instead of
 *      moving straight to the next due row.
 *   2. Every lease and every schedule is `now() + <interval>` evaluated by the DATABASE. The
 *      previous round leased items against the JavaScript clock captured at drain start; at
 *      the production budget (40s, up to 200 items) an item claimed late was leased into the
 *      past the instant it was claimed. Computing it server-side makes that unrepresentable
 *      rather than merely tested for.
 *   3. Every write after a delivery carries `AND claimed_by = <the uuid I claimed with>`. A
 *      result that comes back after its lease lapsed matches nothing and is counted `stale`.
 *
 * `next_attempt_at` means only "when to retry". `attempts` means only "how many tries".
 */
import { and, eq, sql } from "drizzle-orm";
import { getDb, rowsOf } from "@/db";
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

/**
 * The band `backoffFor` can land in for a given attempt, jitter included.
 *
 * Exported so the smoke suite can assert that the DEFAULT, un-overridden path really schedules
 * a step on this ladder — the counterweight to `drainOutbox`'s `backoffMs` override, which
 * pins the duration so the anchor regression test can isolate the anchor. Without this check
 * an override could quietly become the only thing exercised.
 */
export function backoffBoundsMs(attempt: number): { min: number; max: number } {
  const minutes = BACKOFF_MINUTES[Math.min(attempt, BACKOFF_MINUTES.length - 1)]!;
  return { min: minutes * 0.8 * 60_000, max: minutes * 1.2 * 60_000 };
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
 *
 * The revive clears `claimedBy`/`claimedUntil` along with everything else, which is safe
 * precisely BECAUSE the claim token is an identity: it used to reset `attempts` to 0 while
 * `attempts` was also the drain's mutual-exclusion token, which handed a long-gone drain a
 * token that matched again. A revived row's `claimed_by` is NULL, and no drain's uuid is
 * NULL, so no stale owner can match it. An in-flight row is `pending`, so this never fires
 * against one anyway.
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
        claimedBy: null,
        claimedUntil: null,
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
   * A result came back for a row this drain no longer owns — its lease lapsed and a later
   * drain re-claimed it, so the `claimed_by` guard on the post-delivery write matched
   * nothing. Not a delivery and not a failure of THIS attempt: the newer owner's outcome is
   * what actually landed. Should be rare (it means a delivery outlived `CLAIM_LEASE_MS`);
   * worth watching if it isn't.
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
 * can never strand the whole run.
 */
const PER_ITEM_DELIVER_TIMEOUT_MS = 15_000;

/**
 * How long a claim reserves a row before another drain may take it.
 *
 * Comfortably longer than `PER_ITEM_DELIVER_TIMEOUT_MS` on purpose: the claimed window has to
 * cover the deliver call itself PLUS the lookup round trip before it and the resolution write
 * after it, so a lease that only just matched the deliver timeout would leave no slack for
 * that overhead and could lapse mid-write under any real latency.
 *
 * It is spent into `claimed_until` as `now() + <this>` evaluated BY THE DATABASE, inside the
 * claim statement itself — never `opts.now`, never a JavaScript `Date.now()` read at some
 * other point in the loop. That is structural, not a convention to remember: the previous
 * design anchored the lease at the drain's start, and at the production budget (40s, 200
 * items) an item claimed thirty-odd seconds in was leased into the past the moment it was
 * claimed, and instantly re-claimable while genuinely in flight.
 */
export const CLAIM_LEASE_MS = 30_000;

/**
 * The minimum remaining budget worth claiming a row for.
 *
 * The claim and the external-link lookup are each a neon-http round trip — measured in
 * production at roughly 60-160ms combined. Without a floor, a drain running low on budget
 * would claim a row (burning an attempt), then immediately hand `deliver` a timeout of
 * whatever sliver of budget is left — sometimes 0 — so a perfectly healthy delivery gets
 * charged a failed attempt for a call that was never given a chance to run. 500ms covers that
 * round-trip pair with margin; 1500ms on top is the shortest window a real delivery could
 * plausibly complete in. Below the sum, nothing is claimed at all and the row is left for the
 * next drain, untouched.
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

/** What the claim statement hands back. Deliberately no timestamps: raw SQL returns those as
 * driver-specific strings, and nothing in the loop needs them — every subsequent schedule is
 * computed by the database from its own `now()`, not from a value read back into JavaScript. */
type ClaimedRow = {
  id: string;
  user_id: string;
  connector_id: string;
  action: string;
  entity_type: string;
  entity_id: string;
  payload: unknown;
  attempts: number | string;
};

function asPayload(value: unknown): Record<string, unknown> {
  if (typeof value === "string") {
    try {
      return JSON.parse(value) as Record<string, unknown>;
    } catch {
      return {};
    }
  }
  return (value ?? {}) as Record<string, unknown>;
}

export async function drainOutbox(opts: {
  budgetMs: number;
  max: number;
  /**
   * A test seam for DUE-NESS ONLY: "as of when is this drain running." It never reaches a
   * lease or a backoff — those are `now() + <interval>` inside their own statements, so an
   * injected clock cannot make a row look leased into the past. Omit it and even due-ness is
   * the database's own clock.
   */
  now?: Date;
  deliver: (item: OutboxItem) => Promise<DeliverResult>;
  /**
   * Overrides the retry LADDER — how long to wait — and nothing else. Exists because the real
   * ladder is jittered by ±20%, a band far wider than any delay a smoke test can afford, so
   * the anchor regression test cannot otherwise tell "one backoff from when the attempt
   * finished" from "one backoff from when the drain started."
   *
   * Deliberately incapable of the bug class it helps test for: it answers "how long", never
   * "from when". The anchor is `now()` inside the UPDATE, so no caller — test or otherwise —
   * can move it. Contrast `opts.now`, which used to be a test seam AND a scheduling input at
   * once; that overlap is what let an injected clock reach a lease.
   */
  backoffMs?: (attempt: number) => number;
}): Promise<OutboxDrainStats> {
  const deadline = Date.now() + opts.budgetMs;
  const stats: OutboxDrainStats = { attempted: 0, delivered: 0, failed: 0, stale: 0 };
  const db = await getDb();

  const dueAsOf = opts.now ? sql`${opts.now.toISOString()}::timestamptz` : sql`now()`;
  const leaseSeconds = CLAIM_LEASE_MS / 1000;

  // Belt-and-braces against a drain looping on one row: every id this drain has already
  // claimed is excluded from its own later claims. The resolution writes already push the row
  // out of the due window (delivered/dead, or a future `next_attempt_at`), so this only
  // matters when a resolution write was itself stale — but "only in the rare case" is exactly
  // where the last three bugs lived, and an id set costs nothing.
  const claimedThisDrain: string[] = [];

  while (stats.attempted < opts.max) {
    // Not just "is there any budget left" — is there enough left to be worth claiming a row
    // for. Claiming and then immediately handing `deliver` a near-zero timeout charges a
    // perfectly healthy item a failed attempt for a call that never ran; better to leave it
    // untouched for the next drain than to burn its attempts count on a starved timeout.
    if (deadline - Date.now() < ITEM_BUDGET_FLOOR_MS) break;

    // A fresh identity per claim. Never reused, never derived from anything a business rule
    // can reset — which is the whole point, and the reason the previous `attempts`-based
    // token failed: `enqueueOutbox` resets `attempts` to 0 on a revive, so an old drain's
    // token came back around and matched a live row (ABA).
    const worker = crypto.randomUUID();

    // ONE statement: it selects the oldest claimable row, locks it against any concurrent
    // claimer (`FOR UPDATE SKIP LOCKED` — so a competing drain skips past rather than
    // blocking behind it), stamps ownership and the attempt on it, and returns it. There is
    // no window between "found it" and "took it" for a second drain to squeeze into, and
    // nothing to wrap in a transaction, which matters because neon-http has none.
    //
    // A row is claimable when it is pending, due, and unowned — `claimed_until IS NULL OR
    // claimed_until < now()`, which is also how a crashed drain's row comes back on its own
    // without a reaper. `now()` here is the DATABASE's clock for both the lease and the
    // liveness check, so the two can never be read against different clocks.
    const claimed = rowsOf<ClaimedRow>(
      await db.execute(sql`
        UPDATE connector_outbox
           SET claimed_by = ${worker}::uuid,
               claimed_until = now() + (${leaseSeconds}::double precision * interval '1 second'),
               attempts = attempts + 1,
               last_attempted_at = now()
         WHERE id = (
           SELECT id FROM connector_outbox
            WHERE status = 'pending'
              AND next_attempt_at IS NOT NULL
              AND next_attempt_at <= ${dueAsOf}
              AND (claimed_until IS NULL OR claimed_until < now())
              ${
                claimedThisDrain.length
                  ? sql`AND id NOT IN (${sql.join(
                      claimedThisDrain.map((id) => sql`${id}::uuid`),
                      sql`, `
                    )})`
                  : sql.empty()
              }
            ORDER BY next_attempt_at
            FOR UPDATE SKIP LOCKED
            LIMIT 1
         )
        RETURNING id, user_id, connector_id, action, entity_type, entity_id, payload, attempts
      `)
    )[0];
    if (!claimed) break; // nothing claimable right now; a later drain will find whatever lands next

    claimedThisDrain.push(claimed.id);
    stats.attempted++;
    const attempts = Number(claimed.attempts);

    const link = await findExternalLink(
      claimed.user_id,
      claimed.connector_id,
      claimed.entity_type,
      claimed.entity_id
    );
    // One connector's failure — or a hung one — must never stop the queue. The timeout is
    // what makes a hang true: without it a stalled provider could eat the whole drain budget,
    // the route would hit `maxDuration` and be killed before `finishCronRun` ran (stranding a
    // `running` cron_runs row), and — because the claim above already bumped `attempts` —
    // this item still ages normally even though this drain never got an answer.
    const remainingMs = Math.max(0, deadline - Date.now());
    const result = await withTimeout(
      opts.deliver({
        id: claimed.id,
        userId: claimed.user_id,
        connectorId: claimed.connector_id,
        action: claimed.action as OutboxAction,
        entityType: claimed.entity_type,
        entityId: claimed.entity_id,
        payload: asPayload(claimed.payload),
        attempts,
        remoteId: link?.remoteId ?? null,
      }),
      Math.min(PER_ITEM_DELIVER_TIMEOUT_MS, remainingMs)
    );

    if (result.ok) {
      // Record the remote id BEFORE flipping the row to `delivered`, and guard that write on
      // the claim too. The ordering matters for a real cause: `maxDuration` can kill this
      // process between the two writes. Killed after the status update, the row is `delivered`
      // with no link, and the next enqueue re-delivers with `remoteId: null` — so a connector
      // creates a SECOND task in someone's Reminders instead of updating the first, which is
      // the exact harm this whole table exists to prevent. Killed after the link write
      // instead, the row simply stays claimed, its lease lapses, and the redelivery carries
      // the remote id and updates in place. The `claimed_by` guard inside the statement is
      // what keeps record-first from reintroducing the other direction: a lapsed owner cannot
      // write an older remote id over a newer owner's, because it no longer owns the row.
      if (result.remoteId) {
        await recordExternalLinkOwned({
          userId: claimed.user_id,
          connectorId: claimed.connector_id,
          entityType: claimed.entity_type,
          entityId: claimed.entity_id,
          remoteId: result.remoteId,
          outboxId: claimed.id,
          worker,
        });
      }
      const settled = rowsOf<{ id: string }>(
        await db.execute(sql`
          UPDATE connector_outbox
             SET status = 'delivered',
                 delivered_at = now(),
                 last_attempted_at = now(),
                 next_attempt_at = NULL,
                 last_error = NULL,
                 claimed_by = NULL,
                 claimed_until = NULL
           WHERE id = ${claimed.id}::uuid AND claimed_by = ${worker}::uuid
          RETURNING id
        `)
      );
      if (settled.length === 0) {
        // This drain no longer owns the row: its lease lapsed and someone else took it. Their
        // outcome is the one that stands, so this result is neither a delivery nor a failure.
        stats.stale++;
        continue;
      }
      stats.delivered++;
      continue;
    }

    // `attempts` was already bumped by the claim — that IS this attempt, so the exhaustion
    // check reads it rather than re-deriving it. A `retryable: false` result (the connector is
    // gone, the write capability is off) skips the ladder entirely: no future attempt could do
    // anything different, so waiting seven rounds to reach the same `dead` only delays the
    // truth.
    const exhausted = result.retryable === false || attempts >= MAX_OUTBOX_ATTEMPTS;
    // The backoff is `now() + <interval>` computed by the database at the moment this
    // statement runs, so it is anchored to when the attempt actually finished — not to when
    // the drain started, which on a 40s/200-item run could be most of a minute earlier and
    // quietly shortened every late item's backoff. `last_attempted_at` in the same statement
    // shares that one `now()`, which is what the anchor regression test asserts against.
    const backoffSeconds = (opts.backoffMs ?? backoffFor)(attempts) / 1000;
    const settled = rowsOf<{ id: string }>(
      await db.execute(sql`
        UPDATE connector_outbox
           SET status = ${exhausted ? "dead" : "pending"},
               last_error = ${result.error.slice(0, 200)},
               last_attempted_at = now(),
               next_attempt_at = ${
                 exhausted
                   ? sql`NULL`
                   : sql`now() + (${backoffSeconds}::double precision * interval '1 second')`
               },
               claimed_by = NULL,
               claimed_until = NULL
         WHERE id = ${claimed.id}::uuid AND claimed_by = ${worker}::uuid
        RETURNING id
      `)
    );
    if (settled.length === 0) {
      stats.stale++;
      continue;
    }
    stats.failed++;
  }

  return stats;
}

/**
 * The drain's own link write: the same upsert as `recordExternalLink`, but it only happens
 * while this drain still holds the outbox row's claim.
 *
 * `INSERT ... SELECT ... WHERE EXISTS` rather than a read-then-write, because neon-http has no
 * transactions: if the guard is false the SELECT produces no row, so nothing is inserted and
 * `ON CONFLICT` never fires. One statement, no window.
 */
async function recordExternalLinkOwned(input: {
  userId: string;
  connectorId: string;
  entityType: string;
  entityId: string;
  remoteId: string;
  outboxId: string;
  worker: string;
}): Promise<void> {
  const db = await getDb();
  await db.execute(sql`
    INSERT INTO external_links (user_id, connector_id, entity_type, entity_id, remote_id, updated_at)
    SELECT ${input.userId}, ${input.connectorId}, ${input.entityType}, ${input.entityId},
           ${input.remoteId}, now()
     WHERE EXISTS (
       SELECT 1 FROM connector_outbox
        WHERE id = ${input.outboxId}::uuid AND claimed_by = ${input.worker}::uuid
     )
    ON CONFLICT (user_id, connector_id, entity_type, entity_id)
    DO UPDATE SET remote_id = EXCLUDED.remote_id, updated_at = now()
  `);
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
