/**
 * Web push: Orbit's alerts on a phone's lock screen or a desktop's notification centre, even
 * with the app closed (spec rule 5, "it reaches you").
 *
 * One subscription per browser or installed app (`push_subscriptions`), saved when the person
 * presses "Turn on" in Radar's settings. A message goes to every subscription the account has.
 * The push service answers 404 or 410 for a subscription that is gone for good (the person
 * revoked permission, uninstalled, cleared site data): that row is deleted. Any other failure
 * counts up, and a subscription that has failed `MAX_FAILURES` times in a row is dropped too.
 *
 * Dormant until the VAPID keys are set (`NEXT_PUBLIC_VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`,
 * `VAPID_SUBJECT`): nothing is sent and nothing throws.
 *
 * What a message may say: no names, because a lock screen shows it to anyone nearby. The
 * caller passes the text; Radar's comes from `momentPushText`.
 */
import { and, eq, inArray, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { pushSubscriptions } from "@/db/schema";

export type PushPayload = { title: string; body: string; url: string; kind: string };
export type PushTarget = { endpoint: string; keys: { p256dh: string; auth: string } };
/** Send one message; returns the push service's status code (2xx on success). */
export type PushTransport = (target: PushTarget, payload: string) => Promise<{ statusCode: number }>;

const MAX_FAILURES = 5;
/** A message older than this is not worth showing: the moment it was about may have passed. */
const TTL_SEC = 12 * 3600;

export function vapidPublicKey(): string | null {
  return process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY?.trim() || null;
}

export function pushConfigured(): boolean {
  return Boolean(vapidPublicKey() && process.env.VAPID_PRIVATE_KEY?.trim() && process.env.VAPID_SUBJECT?.trim());
}

const webPushTransport: PushTransport = async (target, payload) => {
  // Loaded on send: the library stays off every cold start that sends nothing.
  const webpush = (await import("web-push")).default;
  try {
    const res = await webpush.sendNotification(target, payload, {
      TTL: TTL_SEC,
      urgency: "normal",
      vapidDetails: {
        subject: process.env.VAPID_SUBJECT!.trim(),
        publicKey: vapidPublicKey()!,
        privateKey: process.env.VAPID_PRIVATE_KEY!.trim(),
      },
    });
    return { statusCode: res.statusCode };
  } catch (err) {
    // web-push throws a WebPushError carrying the push service's status for any non-2xx.
    const statusCode = typeof (err as { statusCode?: unknown }).statusCode === "number" ? (err as { statusCode: number }).statusCode : 0;
    return { statusCode };
  }
};

export type PushResult = { sent: number; failed: number; removed: number };

/**
 * Send one message to every subscription the account has. Never throws; with push not
 * configured (and no transport injected) it sends nothing.
 */
export async function sendPushToUser(userId: string, payload: PushPayload, transport?: PushTransport): Promise<PushResult> {
  const result: PushResult = { sent: 0, failed: 0, removed: 0 };
  const send = transport ?? (pushConfigured() ? webPushTransport : null);
  if (!send) return result;
  const db = await getDb();
  const subs = await db.select().from(pushSubscriptions).where(eq(pushSubscriptions.userId, userId));
  if (subs.length === 0) return result;
  const body = JSON.stringify(payload);
  const gone: string[] = [];
  for (const sub of subs) {
    const { statusCode } = await send({ endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } }, body).catch(() => ({ statusCode: 0 }));
    if (statusCode >= 200 && statusCode < 300) {
      result.sent++;
      await db.update(pushSubscriptions).set({ failureCount: 0, lastSuccessAt: new Date() }).where(eq(pushSubscriptions.id, sub.id));
    } else if (statusCode === 404 || statusCode === 410 || sub.failureCount + 1 >= MAX_FAILURES) {
      gone.push(sub.id);
    } else {
      result.failed++;
      await db
        .update(pushSubscriptions)
        .set({ failureCount: sql`${pushSubscriptions.failureCount} + 1` })
        .where(eq(pushSubscriptions.id, sub.id));
    }
  }
  if (gone.length > 0) {
    await db.delete(pushSubscriptions).where(and(eq(pushSubscriptions.userId, userId), inArray(pushSubscriptions.id, gone)));
    result.removed = gone.length;
  }
  return result;
}

/** A browser subscription as `PushSubscription.toJSON()` gives it. Anything else is refused. */
export function parsePushSubscription(raw: unknown): PushTarget | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } };
  if (typeof r.endpoint !== "string" || r.endpoint.length > 1000) return null;
  let url: URL;
  try {
    url = new URL(r.endpoint);
  } catch {
    return null;
  }
  // Push services are HTTPS on the public internet; anything else would make the server a
  // request proxy for whoever controls the "endpoint".
  if (url.protocol !== "https:" || /^(localhost|127\.|10\.|192\.168\.|169\.254\.|\[)/.test(url.hostname)) return null;
  const p256dh = r.keys?.p256dh;
  const auth = r.keys?.auth;
  if (typeof p256dh !== "string" || typeof auth !== "string" || p256dh.length > 200 || auth.length > 100) return null;
  if (!/^[A-Za-z0-9_-]+=*$/.test(p256dh) || !/^[A-Za-z0-9_-]+=*$/.test(auth)) return null;
  return { endpoint: r.endpoint, keys: { p256dh, auth } };
}

/** Save this browser's subscription for the account. An endpoint is one browser: re-saving moves it. */
export async function savePushSubscription(userId: string, target: PushTarget, userAgent: string | null): Promise<void> {
  const db = await getDb();
  const ua = userAgent?.slice(0, 300) ?? null;
  await db
    .insert(pushSubscriptions)
    .values({ userId, endpoint: target.endpoint, p256dh: target.keys.p256dh, auth: target.keys.auth, userAgent: ua })
    .onConflictDoUpdate({
      target: pushSubscriptions.endpoint,
      set: { userId, p256dh: target.keys.p256dh, auth: target.keys.auth, userAgent: ua, failureCount: 0 },
    });
}

export async function removePushSubscription(userId: string, endpoint: string): Promise<void> {
  const db = await getDb();
  await db.delete(pushSubscriptions).where(and(eq(pushSubscriptions.userId, userId), eq(pushSubscriptions.endpoint, endpoint)));
}
