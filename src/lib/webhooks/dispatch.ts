/**
 * Delivering events to user-registered endpoints.
 *
 * ## Durability lives in the row, not the attempt
 *
 * `enqueueWebhookEvent` writes the delivery synchronously inside the request that caused the
 * event. Only then is an immediate attempt made, as a best-effort optimisation. That ordering
 * is the entire reliability story: if the invocation is killed mid-flight, the row is already
 * there and the sweep picks it up. The reverse ordering — try first, persist on failure —
 * loses every event that dies between the two.
 *
 * ## Why the retry engine is a sweep
 *
 * The obvious design is to retry inline with backoff. It cannot work here: `after()` runs
 * within the route's `maxDuration`, so it defers work past the response without buying more
 * time, and Vercel Hobby's single daily cron already belongs to `process-stalled`. So the
 * immediate attempt is hard-capped and retries are drained by the existing ten-minute GitHub
 * Actions schedule.
 *
 * ## SSRF is the highest-severity concern in this file
 *
 * Everything below fetches a URL a user supplied. Validation at registration is necessary but
 * NOT sufficient: a hostname that resolved to a public address when it was registered can
 * resolve to 169.254.169.254 by the time it is delivered to. So DNS is resolved immediately
 * before the request and the resulting address is checked, redirects are never followed, and
 * the response body is never echoed back beyond a short truncated snippet — because the
 * response is the channel an attacker would read secrets out of.
 */
import { getEntitlements } from "@/lib/entitlements";
import { randomUUID } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import { getDb, rowsOf } from "@/db";
import { outboundWebhookDeliveries, webhookEndpoints } from "@/db/schema";
import { decryptAndRewrap } from "@/lib/crypto-rewrap";
import { buildEnvelope, signPayload, type WebhookEventType } from "@/lib/webhooks/sign";

/** Per-attempt HTTP timeout. A slow endpoint must not consume the drain's budget. */
const ATTEMPT_TIMEOUT_MS = 5_000;

/** Attempts before a delivery is abandoned. */
export const MAX_DELIVERY_ATTEMPTS = 7;

/** Consecutive failed deliveries before the endpoint itself is switched off. */
export const MAX_CONSECUTIVE_FAILURES = 10;

/** Endpoints attempted inline, before falling back to the sweep. */
const INLINE_ENDPOINT_LIMIT = 5;

/**
 * Nominal backoff ladder in minutes.
 *
 * Honest caveat: the drain runs every ten minutes, so the first two steps collapse into
 * "next sweep". The ladder is still worth stating because the later steps do bind, and
 * because someone reading the retry schedule should see the intent rather than infer it.
 */
const BACKOFF_MINUTES = [0.5, 2, 10, 60, 360, 1440];

function backoffFor(attempt: number): number {
  const minutes = BACKOFF_MINUTES[Math.min(attempt, BACKOFF_MINUTES.length - 1)];
  // ±20% jitter. Without it, a provider-wide outage brings every pending delivery back on
  // exactly the same ten-minute boundary once it clears.
  const jittered = minutes * (0.8 + Math.random() * 0.4);
  return jittered * 60_000;
}

/**
 * The SSRF guard now lives in `@/lib/net-guard` so it can be shared with the event-page
 * fetcher without dragging `@/db` into a `pure`-tier smoke test. Re-exported here because
 * `src/actions/webhook-endpoints.ts`, `src/app/api/v1/webhook-endpoints/route.ts` and
 * `scripts/smoke-webhook-delivery.ts` all import it from this module.
 */
import { assertDeliverable, isBlockedAddress, readBodyCapped } from "@/lib/net-guard";
import { reportError } from "@/lib/report-error";

export { isBlockedAddress, assertDeliverable };

/**
 * Queue an event for every endpoint subscribed to it.
 *
 * Never throws: a webhook is a side effect of the user's action, and failing to queue one must
 * not fail the create that caused it.
 */
export async function enqueueWebhookEvent(
  userId: string,
  type: WebhookEventType,
  object: unknown,
  /**
   * A caller-chosen event id, for events a sweep may notice repeatedly.
   *
   * The unique index on `(endpoint_id, event_id)` then does the deduplication: a
   * `followup.due` keyed on `${contactId}:${date}` fires once for that person that day, no
   * matter how many times the ten-minute drain sees them still due. Omit it for events caused
   * by a single user action, where every occurrence is genuinely new.
   */
  opts: { eventId?: string } = {}
): Promise<string[]> {
  return enqueueWebhookEvents(userId, type, [{ object, eventId: opts.eventId }]);
}

/**
 * `enqueueWebhookEvent` for several events of one type at once: the endpoints are read once
 * and every delivery row goes in one multi-row insert, so a sweep queueing N events costs two
 * statements rather than 2N. Same contract — never throws, returns the endpoint ids to try
 * inline (empty when nothing is subscribed or the queue write failed).
 */
export async function enqueueWebhookEvents(
  userId: string,
  type: WebhookEventType,
  events: Array<{ object: unknown; eventId?: string }>
): Promise<string[]> {
  if (events.length === 0) return [];
  try {
    const db = await getDb();
    const endpoints = await db.query.webhookEndpoints.findMany({
      where: and(eq(webhookEndpoints.userId, userId), eq(webhookEndpoints.status, "active")),
      columns: { id: true, eventTypes: true },
    });
    const subscribed = endpoints.filter((e) => (e.eventTypes ?? []).includes(type));
    if (subscribed.length === 0) return [];
    // Outbound webhooks are Max and Lifetime only (pricing v2). A Pro account's endpoints are
    // kept exactly as they are — never disabled in the table, never deleted — and simply
    // receive nothing until the account is on a plan that includes them again. Checked after
    // the endpoint read, so the common case (no endpoints) costs no plan lookup.
    if (!(await getEntitlements(userId)).canUseApi) return [];

    const createdAt = new Date();
    const rows = events.flatMap(({ object, eventId: chosen }) => {
      const eventId = chosen
        ? `evt_${chosen}`
        : `evt_${randomUUID().replace(/-/g, "")}`;
      const envelope = buildEnvelope({ id: eventId, type, createdAt, object });
      return subscribed.map((e) => ({
        userId,
        endpointId: e.id,
        eventId,
        eventType: type,
        payload: envelope,
        status: "pending" as const,
        nextAttemptAt: createdAt,
      }));
    });

    await db
      .insert(outboundWebhookDeliveries)
      .values(rows)
      // Makes enqueue idempotent: a retried write cannot double-deliver.
      .onConflictDoNothing();

    return subscribed.slice(0, INLINE_ENDPOINT_LIMIT).map((e) => e.id);
  } catch (err) {
    // The sweep is the safety net; a queue failure must never surface to the caller — but
    // an event that was never queued is an integration that silently missed it, so report.
    reportError(err, { where: "job.webhooks.enqueue", userId, extra: { type } });
    return [];
  }
}

type DueRow = {
  id: string;
  endpoint_id: string;
  payload: unknown;
  attempts: number;
  url: string;
  secret_encrypted: string;
  /** The drain's claim on this row. Set by `claimDueDeliveries`; settles land only under it. */
  claim_token?: string | null;
};

/**
 * How long a drain owns the rows it claimed. Longer than its whole budget (45 s) so a row is
 * never re-claimed mid-attempt; short enough that a drain that died frees its rows by the
 * next ten-minute tick.
 */
export const DELIVERY_CLAIM_MS = 2 * 60 * 1000;

/**
 * Deliveries one endpoint may take per pass. The drain is shared by every account and runs
 * oldest-first; without a ceiling, one account with ten slow endpoints and a bulk import filled
 * every pass with its own five-second timeouts while everyone else's deliveries waited
 * (audit M-03). Five per endpoint per pass still clears a normal backlog in a few ticks.
 */
export const MAX_PER_ENDPOINT_PER_PASS = 5;

/** The most of an error response body ever read. The 200 kept is cut from this. */
const ERROR_BODY_MAX_BYTES = 4096;

/** A settle lands on the row only while this drain still holds the claim it was handed. */
function settleWhere(row: DueRow) {
  return row.claim_token
    ? and(eq(outboundWebhookDeliveries.id, row.id), eq(outboundWebhookDeliveries.claimedBy, row.claim_token))
    : eq(outboundWebhookDeliveries.id, row.id);
}

/**
 * Claim the next due deliveries for this drain, in one statement (audit M-03).
 *
 * The drain used to SELECT its rows and then attempt each one; two overlapping drains (the
 * schedule and a manual dispatch run in different concurrency groups) selected the same rows
 * and POSTed each event twice. Claiming is an UPDATE: the second drain's statement waits on
 * the first one's row locks, re-checks `claimed_until`, and skips rows already taken.
 *
 * Fair across endpoints: at most `MAX_PER_ENDPOINT_PER_PASS` rows per endpoint, then the
 * oldest overall. The endpoint's url and secret come back on the same row.
 */
export async function claimDueDeliveries(opts: { max: number; now: Date; token: string }): Promise<DueRow[]> {
  const db = await getDb();
  const until = new Date(opts.now.getTime() + DELIVERY_CLAIM_MS);
  return rowsOf<DueRow>(
    await db.execute(sql`
      WITH due AS (
        SELECT d.id, d.next_attempt_at,
               row_number() OVER (PARTITION BY d.endpoint_id ORDER BY d.next_attempt_at, d.id) AS rn
          FROM outbound_webhook_deliveries d
          JOIN webhook_endpoints e ON e.id = d.endpoint_id
         WHERE d.status = 'pending'
           AND d.next_attempt_at IS NOT NULL
           AND d.next_attempt_at <= ${opts.now}
           AND e.status = 'active'
           AND (d.claimed_until IS NULL OR d.claimed_until < ${opts.now})
      ),
      picked AS (
        SELECT id FROM due
         WHERE rn <= ${MAX_PER_ENDPOINT_PER_PASS}
         ORDER BY next_attempt_at, id
         LIMIT ${opts.max}
      )
      UPDATE outbound_webhook_deliveries d
         SET claimed_by = ${opts.token}, claimed_until = ${until}
        FROM picked
       WHERE d.id = picked.id
         AND d.status = 'pending'
         AND (d.claimed_until IS NULL OR d.claimed_until < ${opts.now})
      RETURNING d.id, d.endpoint_id, d.payload, d.attempts, d.claimed_by AS claim_token,
                (SELECT e.url FROM webhook_endpoints e WHERE e.id = d.endpoint_id) AS url,
                (SELECT e.secret_encrypted FROM webhook_endpoints e WHERE e.id = d.endpoint_id) AS secret_encrypted
    `)
  );
}

/**
 * Round-robin across endpoints, so the time budget is shared rather than spent on whichever
 * endpoint's rows happened to come back first. RETURNING carries no order of its own.
 */
function interleaveByEndpoint(rows: DueRow[]): DueRow[] {
  const queues = new Map<string, DueRow[]>();
  for (const row of rows) {
    const q = queues.get(row.endpoint_id);
    if (q) q.push(row);
    else queues.set(row.endpoint_id, [row]);
  }
  const out: DueRow[] = [];
  while (out.length < rows.length) {
    for (const q of queues.values()) {
      const next = q.shift();
      if (next) out.push(next);
    }
  }
  return out;
}

/**
 * Attempt one delivery and record the outcome.
 *
 * Returns whether it was delivered, so the drain can count without re-reading.
 */
export async function attemptDelivery(row: DueRow, now: Date = new Date()): Promise<boolean> {
  const db = await getDb();
  const body = JSON.stringify(row.payload);
  const attempt = row.attempts + 1;

  let statusCode: number | null = null;
  let error: string | null = null;

  try {
    await assertDeliverable(row.url);
    const secret = await decryptAndRewrap(row.secret_encrypted, {
      table: webhookEndpoints,
      column: webhookEndpoints.secretEncrypted,
      idColumn: webhookEndpoints.id,
      id: row.endpoint_id,
    });
    if (!secret) throw new Error("Endpoint secret could not be read");

    const timestamp = Math.floor(now.getTime() / 1000);
    const res = await fetch(row.url, {
      method: "POST",
      // A 302 to the metadata endpoint must never be followed.
      redirect: "manual",
      signal: AbortSignal.timeout(ATTEMPT_TIMEOUT_MS),
      headers: {
        "content-type": "application/json",
        "user-agent": "Orbit-Webhooks/1",
        "Orbit-Signature": signPayload(secret, body, timestamp),
        "Orbit-Event-Id": String((row.payload as { id?: string })?.id ?? ""),
        "Orbit-Delivery-Attempt": String(attempt),
      },
      body,
    });
    statusCode = res.status;
    // Only 2xx is success. A 3xx is a misconfigured endpoint, not a delivery.
    if (res.status < 200 || res.status >= 300) {
      // Capped while streaming: `res.text()` read the whole body first, and the 5 s abort
      // bounds time, not bytes — a hostile endpoint could stream tens of MB into memory.
      const capped = await readBodyCapped(res, ERROR_BODY_MAX_BYTES).catch(() => null);
      const text = capped ? capped.toString("utf8") : "(response body too large)";
      // 200 characters, never more: the response body is an exfiltration channel, and this
      // string is shown back to the user in Settings.
      error = `HTTP ${res.status}: ${text.slice(0, 200)}`;
    }
  } catch (err) {
    error = err instanceof Error ? err.message.slice(0, 200) : "Delivery failed";
  }

  if (!error) {
    await db
      .update(outboundWebhookDeliveries)
      .set({
        status: "delivered",
        attempts: attempt,
        lastStatusCode: statusCode,
        lastError: null,
        lastAttemptedAt: now,
        deliveredAt: now,
        nextAttemptAt: null,
        claimedBy: null,
        claimedUntil: null,
      })
      .where(settleWhere(row));
    await db
      .update(webhookEndpoints)
      .set({ consecutiveFailures: 0, updatedAt: now })
      .where(eq(webhookEndpoints.id, row.endpoint_id));
    return true;
  }

  const exhausted = attempt >= MAX_DELIVERY_ATTEMPTS;
  await db
    .update(outboundWebhookDeliveries)
    .set({
      status: exhausted ? "dead" : "pending",
      attempts: attempt,
      lastStatusCode: statusCode,
      lastError: error,
      lastAttemptedAt: now,
      nextAttemptAt: exhausted ? null : new Date(now.getTime() + backoffFor(attempt)),
      claimedBy: null,
      claimedUntil: null,
    })
    .where(settleWhere(row));

  if (exhausted) {
    // Only an abandoned delivery counts against the endpoint. Counting every failed attempt
    // would disable an endpoint after two flaky deliveries rather than ten dead ones.
    const bumped = rowsOf<{ consecutive_failures: number }>(
      await db.execute(sql`
        UPDATE webhook_endpoints
           SET consecutive_failures = consecutive_failures + 1, updated_at = ${now}
         WHERE id = ${row.endpoint_id}
        RETURNING consecutive_failures
      `)
    )[0];
    if (Number(bumped?.consecutive_failures ?? 0) >= MAX_CONSECUTIVE_FAILURES) {
      await db
        .update(webhookEndpoints)
        .set({
          status: "disabled",
          disabledAt: now,
          disabledReason: `${MAX_CONSECUTIVE_FAILURES} consecutive deliveries failed`,
          updatedAt: now,
        })
        .where(eq(webhookEndpoints.id, row.endpoint_id));
    }
  }
  return false;
}

/**
 * Prove an endpoint exists and is willing to receive before it is switched on.
 *
 * A new endpoint starts `pending`, and only a 2xx to this signed `endpoint.verified` delivery
 * moves it to `active`. Without the handshake a typo'd URL would sit there collecting nothing
 * and the user would have no way to tell that from "nothing has happened yet" — which is the
 * single most common way a webhook integration is quietly broken for weeks.
 *
 * It also proves the receiver can validate the signature, because that is the same request
 * shape every real delivery will have.
 */
export async function verifyEndpoint(
  endpointId: string,
  now: Date = new Date()
): Promise<{ ok: boolean; error?: string }> {
  const db = await getDb();
  const endpoint = await db.query.webhookEndpoints.findFirst({
    where: eq(webhookEndpoints.id, endpointId),
    columns: { id: true, url: true, secretEncrypted: true },
  });
  if (!endpoint) return { ok: false, error: "No such endpoint" };

  const envelope = buildEnvelope({
    id: `evt_verify_${randomUUID().replace(/-/g, "")}`,
    type: "endpoint.verified",
    createdAt: now,
    object: { endpointId },
  });
  const body = JSON.stringify(envelope);

  try {
    await assertDeliverable(endpoint.url);
    const secret = await decryptAndRewrap(endpoint.secretEncrypted, {
      table: webhookEndpoints,
      column: webhookEndpoints.secretEncrypted,
      idColumn: webhookEndpoints.id,
      id: endpoint.id,
    });
    if (!secret) throw new Error("Endpoint secret could not be read");

    const res = await fetch(endpoint.url, {
      method: "POST",
      redirect: "manual",
      signal: AbortSignal.timeout(ATTEMPT_TIMEOUT_MS),
      headers: {
        "content-type": "application/json",
        "user-agent": "Orbit-Webhooks/1",
        "Orbit-Signature": signPayload(secret, body, Math.floor(now.getTime() / 1000)),
        "Orbit-Event-Id": envelope.id,
        "Orbit-Delivery-Attempt": "1",
      },
      body,
    });
    if (res.status < 200 || res.status >= 300) {
      return { ok: false, error: `Endpoint answered HTTP ${res.status}` };
    }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message.slice(0, 200) : "Unreachable" };
  }

  await db
    .update(webhookEndpoints)
    .set({ status: "active", consecutiveFailures: 0, disabledAt: null, disabledReason: null, updatedAt: now })
    .where(eq(webhookEndpoints.id, endpointId));
  return { ok: true };
}

/** The drain sweep's cadence; the follow-up window advances once per slot. */
const FOLLOWUP_SWEEP_SLOT_MS = 10 * 60 * 1000;

/**
 * `size` items starting at a slot-dependent offset, wrapping around. Consecutive slots take
 * consecutive windows, so over ceil(n / size) sweeps every item is served once.
 */
export function rotatingWindow<T>(items: readonly T[], size: number, slot: number): T[] {
  if (items.length <= size) return [...items];
  const start = (((slot * size) % items.length) + items.length) % items.length;
  return Array.from({ length: size }, (_, i) => items[(start + i) % items.length]!);
}

/**
 * Emit `followup.due` for anyone with a subscribed endpoint.
 *
 * Driven from the drain sweep rather than a per-user trigger, because "this relationship has
 * gone cold" is a state rather than an event — nothing happens at the moment it becomes true.
 * Scoped to users who actually have a subscribed endpoint, which is normally none, so the
 * usual cost of this function is a single query returning zero rows.
 *
 * The event id is `followup:<contactId>:<date>`, so the unique index collapses the ten-minute
 * sweep into at most one delivery per person per day. Without that, subscribing to this event
 * would mean 144 identical webhooks a day for every cold contact.
 */
export async function emitDueFollowupEvents(
  limitUsers = 20,
  now: Date = new Date()
): Promise<{ users: number; events: number }> {
  const db = await getDb();
  // Every subscriber, ordered, then a window that rotates with the ten-minute slot. The
  // query used to be `DISTINCT … LIMIT 20` with no order, so past 20 subscribers the same
  // ones could be served on every sweep and the rest never. The list is one row per
  // subscribed account (normally none), small enough to read whole.
  const subscribers = rowsOf<{ user_id: string }>(
    await db.execute(sql`
      SELECT DISTINCT user_id FROM webhook_endpoints
       WHERE status = 'active' AND event_types ? 'followup.due'
       ORDER BY user_id
    `)
  );
  const users = rotatingWindow(subscribers, limitUsers, Math.floor(now.getTime() / FOLLOWUP_SWEEP_SLOT_MS));
  if (users.length === 0) return { users: 0, events: 0 };

  const day = now.toISOString().slice(0, 10);
  // The dashboard's due list without the rest of the dashboard: this runs every ten minutes
  // for every subscribed account.
  const { loadDueFollowUps } = await import("@/lib/due-follow-ups");
  let events = 0;
  for (const { user_id: userId } of users) {
    try {
      const due = (await loadDueFollowUps(userId)).slice(0, 25);
      // One endpoint read and one insert for the whole list, not two statements a contact.
      const queued = await enqueueWebhookEvents(
        userId,
        "followup.due",
        due.map((contact) => ({
          object: {
            contactId: contact.id,
            name: contact.fullName,
            company: contact.company ?? null,
            email: contact.email ?? null,
            dueAt: contact.nextFollowUpAt
              ? new Date(contact.nextFollowUpAt).toISOString()
              : null,
          },
          eventId: `followup:${contact.id}:${day}`,
        }))
      );
      if (queued.length > 0) events += due.length;
    } catch (err) {
      // One user's dashboard failing must not stop the others.
      reportError(err, { where: "job.webhooks.followup-emit", level: "warning" });
    }
  }
  return { users: users.length, events };
}

export type DrainStats = { attempted: number; delivered: number; failed: number };

/**
 * Deliver what is due, inside a wall-clock budget.
 *
 * The budget is checked before each item, never after — a deadline tested after the work has
 * already run bounds nothing.
 */
export async function drainDueDeliveries(
  opts: { budgetMs: number; max: number; now?: Date } = { budgetMs: 45_000, max: 200 }
): Promise<DrainStats> {
  const now = opts.now ?? new Date();
  const deadline = Date.now() + opts.budgetMs;
  const stats: DrainStats = { attempted: 0, delivered: 0, failed: 0 };

  // Claimed, not merely selected: see `claimDueDeliveries`.
  const token = randomUUID();
  const due = interleaveByEndpoint(await claimDueDeliveries({ max: opts.max, now, token }));

  let index = 0;
  for (; index < due.length; index++) {
    if (Date.now() >= deadline) break;
    stats.attempted++;
    // One endpoint's failure must never stop the queue.
    const ok = await attemptDelivery(due[index]!, now).catch(() => false);
    if (ok) stats.delivered++;
    else stats.failed++;
  }
  // Rows the budget never reached go back now, not when the claim expires.
  const unattempted = due.slice(index).map((r) => r.id);
  if (unattempted.length) {
    const db = await getDb();
    await db
      .update(outboundWebhookDeliveries)
      .set({ claimedBy: null, claimedUntil: null })
      .where(and(inArray(outboundWebhookDeliveries.id, unattempted), eq(outboundWebhookDeliveries.claimedBy, token)));
  }
  return stats;
}

/** Purge idempotency records past their useful life. Called from the same sweep. */
export async function purgeExpiredIdempotencyKeys(olderThan: Date): Promise<void> {
  const db = await getDb();
  await db.execute(sql`DELETE FROM api_idempotency_keys WHERE created_at < ${olderThan}`);
}