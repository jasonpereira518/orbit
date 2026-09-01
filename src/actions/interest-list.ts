"use server";

import { isNotNull, sql } from "drizzle-orm";
import { cookies, headers } from "next/headers";
import { getDb } from "@/db";
import { interestListSignups } from "@/db/schema";
import { ATTRIBUTION_COOKIE, parseAttribution } from "@/lib/attribution-parse";
import {
  asWelcomePlanet,
  buildUnsubscribeUrl,
  generateUnsubscribeToken,
  planetForSignupNumber,
  sendInterestListWelcomeEmail,
} from "@/lib/interest-list-email";
import {
  MIN_FILL_MS,
  interestListSchema,
  type InterestListInput,
  type InterestListResult,
} from "@/lib/interest-list";

/**
 * Per-instance throttle, same shape as `src/actions/contact.ts`. A speed bump, not a
 * guarantee: a distributed flood would land on several instances and slip through. If that
 * ever happens, the upgrade is Vercel BotID in front of this action rather than a bigger Map.
 */
const RATE_WINDOW_MS = 10 * 60_000;
const RATE_MAX = 5;
const recentByIp = new Map<string, number[]>();

function overRateLimit(key: string, now: number) {
  const recent = (recentByIp.get(key) ?? []).filter((at) => now - at < RATE_WINDOW_MS);
  if (recent.length >= RATE_MAX) {
    recentByIp.set(key, recent);
    return true;
  }
  recent.push(now);
  recentByIp.set(key, recent);

  // The map should only ever hold senders inside the window; without this it grows for the
  // lifetime of the instance.
  if (recentByIp.size > 500) {
    for (const [ip, times] of recentByIp) {
      if (times.every((at) => now - at >= RATE_WINDOW_MS)) recentByIp.delete(ip);
    }
  }
  return false;
}

export async function joinInterestList(
  input: InterestListInput
): Promise<InterestListResult> {
  const parsed = interestListSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, message: "That address doesn't look right." };
  }

  const { email, elapsedMs } = parsed.data;

  // A bot that trips the honeypot or submits faster than a person can read the form gets
  // the same generic success message as a real signup — never confirm to the caller which
  // check it failed, or a script just adjusts and retries.
  if (elapsedMs < MIN_FILL_MS) {
    return { ok: true };
  }

  const headerList = await headers();
  // First hop in x-forwarded-for is the client; the rest are proxies.
  const ip =
    headerList.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    headerList.get("x-real-ip")?.trim() ||
    "unknown";

  if (overRateLimit(ip, Date.now())) {
    // Same success response as a normal join — a rate-limited visitor should not be able to
    // tell the difference from the outside.
    return { ok: true };
  }

  const cookieStore = await cookies();
  const attribution = parseAttribution(cookieStore.get(ATTRIBUTION_COOKIE)?.value ?? null);

  const db = await getDb();

  // The planet this signup would get if it turns out to be new: one step further from the
  // sun than the last. Counted before the insert so the number is this row's own ordinal.
  // An existing row keeps whatever planet it was given, so a resubscribe's second welcome
  // still matches the postscript the first one printed.
  const [before] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(interestListSignups);
  const nextPlanet = planetForSignupNumber((before?.n ?? 0) + 1);

  // Single atomic upsert rather than a read-then-write: a brand-new email inserts; an
  // email that previously unsubscribed re-activates; an email that is already an active
  // subscriber matches neither branch (`setWhere` fails), so `ON CONFLICT` applies no
  // update and RETURNING yields nothing for it — which is exactly how we tell "just
  // joined or rejoined" (send the welcome email) apart from "already on the list, this is
  // a duplicate submit" (stay silent, no repeat email).
  const rows = await db
    .insert(interestListSignups)
    .values({
      email: email.trim().toLowerCase(),
      referrer: attribution?.referrer ?? null,
      utmSource: attribution?.utmSource ?? null,
      utmMedium: attribution?.utmMedium ?? null,
      utmCampaign: attribution?.utmCampaign ?? null,
      landingPath: attribution?.landingPath ?? null,
      unsubscribeToken: generateUnsubscribeToken(),
      welcomePlanet: nextPlanet,
    })
    .onConflictDoUpdate({
      target: interestListSignups.email,
      // Rejoining restarts the sequence: clearing `followUpSentAt` re-arms the day-3 note.
      // `welcomePlanet` is deliberately absent — their planet is theirs, and rewriting it
      // would contradict the postscript in the mail they already have.
      set: { unsubscribedAt: null, followUpSentAt: null },
      setWhere: isNotNull(interestListSignups.unsubscribedAt),
    })
    // Bare, not `.returning({ email, unsubscribeToken })` — an explicit field selector
    // defeats Drizzle's overload resolution after `.onConflictDoUpdate()` in this TS
    // version (see the same note in `import-engine.ts`). Bare returns every column.
    .returning();

  const row = rows[0];
  if (row) {
    // Best-effort — see `sendInterestListWelcomeEmail`. The signup above already
    // succeeded, so a Resend hiccup must not turn this into a failed submission.
    await sendInterestListWelcomeEmail(
      row.email,
      buildUnsubscribeUrl(row.unsubscribeToken),
      asWelcomePlanet(row.welcomePlanet)
    );
  }

  return { ok: true };
}
