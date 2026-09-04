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
import { lookup } from "node:dns/promises";
import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { getDb, rowsOf } from "@/db";
import { outboundWebhookDeliveries, webhookEndpoints } from "@/db/schema";
import { decryptOrNull } from "@/lib/crypto";
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
 * Whether an IP literal is somewhere Orbit must never be made to talk to.
 *
 * The cloud metadata endpoint (169.254.169.254) is the one that matters most — it hands out
 * credentials to anything that can reach it — but loopback and private ranges are equally
 * off-limits, because reaching them means the caller has borrowed Orbit's network position.
 */
export function isBlockedAddress(address: string): boolean {
  const ip = address.trim().toLowerCase();

  // IPv6, including the mapped-IPv4 form that would otherwise slip past the v4 checks.
  if (ip.includes(":")) {
    if (ip === "::1" || ip === "::") return true;
    // fc00::/7 (unique local) and fe80::/10 (link local).
    if (/^f[cd]/.test(ip)) return true;
    if (/^fe[89ab]/.test(ip)) return true;
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(ip);
    if (mapped) return isBlockedAddress(mapped[1]);
    return false;
  }

  const parts = ip.split(".").map(Number);
  if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) {
    // Unparseable is not provably safe.
    return true;
  }
  const [a, b] = parts;
  if (a === 0) return true; // "this network"
  if (a === 10) return true; // RFC1918
  if (a === 127) return true; // loopback
  if (a === 169 && b === 254) return true; // link-local, incl. cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true; // RFC1918
  if (a === 192 && b === 168) return true; // RFC1918
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  if (a >= 224) return true; // multicast and reserved
  return false;
}

/**
 * Resolve the URL's host and refuse anything internal.
 *
 * Called immediately before the fetch, deliberately. Checking only at registration is
 * defeated by DNS rebinding: the attacker registers a hostname that resolves publicly, then
 * repoints it. This narrows that window to the gap between this lookup and the request —
 * genuinely narrowed, not closed; fully closing it needs a fetch pinned to the resolved IP.
 */
export async function assertDeliverable(url: string): Promise<void> {
  const parsed = new URL(url);
  if (parsed.protocol !== "https:") throw new Error("Only https:// endpoints are allowed");
  if (parsed.username || parsed.password) throw new Error("Credentials in URL are not allowed");

  const host = parsed.hostname.replace(/^\[|\]$/g, "");
  if (/\.(local|internal|localdomain)$/i.test(host) || host === "localhost") {
    throw new Error("Internal hostnames are not allowed");
  }

  // A bare IP literal never needs DNS; check it directly.
  if (/^[\d.]+$/.test(host) || host.includes(":")) {
    if (isBlockedAddress(host)) throw new Error("That address is not allowed");
    return;
  }

  const resolved = await lookup(host, { all: true });
  if (resolved.length === 0) throw new Error("Host did not resolve");
  for (const entry of resolved) {
    if (isBlockedAddress(entry.address)) {
      throw new Error("That host resolves to an internal address");
    }
  }
}

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
  try {
    const db = await getDb();
    const endpoints = await db.query.webhookEndpoints.findMany({
      where: and(eq(webhookEndpoints.userId, userId), eq(webhookEndpoints.status, "active")),
      columns: { id: true, eventTypes: true },
    });
    const subscribed = endpoints.filter((e) => (e.eventTypes ?? []).includes(type));
    if (subscribed.length === 0) return [];

    const eventId = opts.eventId
      ? `evt_${opts.eventId}`
      : `evt_${randomUUID().replace(/-/g, "")}`;
    const envelope = buildEnvelope({ id: eventId, type, createdAt: new Date(), object });

    await db
      .insert(outboundWebhookDeliveries)
      .values(
        subscribed.map((e) => ({
          userId,
          endpointId: e.id,
          eventId,
          eventType: type,
          payload: envelope,
          status: "pending" as const,
          nextAttemptAt: new Date(),
        }))
      )
      // Makes enqueue idempotent: a retried write cannot double-deliver.
      .onConflictDoNothing();

    return subscribed.slice(0, INLINE_ENDPOINT_LIMIT).map((e) => e.id);
  } catch {
    // The sweep is the safety net; a queue failure must never surface to the caller.
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
};

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
    const secret = decryptOrNull(row.secret_encrypted);
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
      const text = await res.text().catch(() => "");
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
      })
      .where(eq(outboundWebhookDeliveries.id, row.id));
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
    })
    .where(eq(outboundWebhookDeliveries.id, row.id));

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
    const secret = decryptOrNull(endpoint.secretEncrypted);
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
  const users = rowsOf<{ user_id: string }>(
    await db.execute(sql`
      SELECT DISTINCT user_id FROM webhook_endpoints
       WHERE status = 'active' AND event_types ? 'followup.due'
       LIMIT ${limitUsers}
    `)
  );
  if (users.length === 0) return { users: 0, events: 0 };

  const day = now.toISOString().slice(0, 10);
  const { getDashboardData } = await import("@/lib/reminders");
  let events = 0;
  for (const { user_id: userId } of users) {
    try {
      const data = await getDashboardData(userId);
      for (const contact of data.dueFollowUps.slice(0, 25)) {
        const queued = await enqueueWebhookEvent(
          userId,
          "followup.due",
          {
            contactId: contact.id,
            name: contact.fullName,
            company: contact.company ?? null,
            email: contact.email ?? null,
            dueAt: contact.nextFollowUpAt
              ? new Date(contact.nextFollowUpAt).toISOString()
              : null,
          },
          { eventId: `followup:${contact.id}:${day}` }
        );
        if (queued.length > 0) events++;
      }
    } catch {
      // One user's dashboard failing must not stop the others.
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
  const db = await getDb();

  const due = rowsOf<DueRow>(
    await db.execute(sql`
      SELECT d.id, d.endpoint_id, d.payload, d.attempts, e.url, e.secret_encrypted
        FROM outbound_webhook_deliveries d
        JOIN webhook_endpoints e ON e.id = d.endpoint_id
       WHERE d.status = 'pending'
         AND d.next_attempt_at IS NOT NULL
         AND d.next_attempt_at <= ${now}
         AND e.status = 'active'
       ORDER BY d.next_attempt_at
       LIMIT ${opts.max}
    `)
  );

  for (const row of due) {
    if (Date.now() >= deadline) break;
    stats.attempted++;
    // One endpoint's failure must never stop the queue.
    const ok = await attemptDelivery(row, now).catch(() => false);
    if (ok) stats.delivered++;
    else stats.failed++;
  }
  return stats;
}

/** Purge idempotency records past their useful life. Called from the same sweep. */
export async function purgeExpiredIdempotencyKeys(olderThan: Date): Promise<void> {
  const db = await getDb();
  await db.execute(sql`DELETE FROM api_idempotency_keys WHERE created_at < ${olderThan}`);
}