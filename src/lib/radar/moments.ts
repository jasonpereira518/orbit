/**
 * Radar's same-day alerts (spec rule 5, PR 9b): when something on the Today strip won't keep,
 * Radar tells the person — a push to every device they turned it on for, and at most one
 * email that day.
 *
 * The rules, in the order they bind:
 *   - Only Today items (`bucket = 'today'`: due within 48 hours, fresh, or owed) ever alert.
 *   - At most `RADAR_ALERTS_PER_DAY` cards a local day, and never twice for the same card.
 *     Both are rate buckets, spent BEFORE anything is sent: a run that dies loses an alert
 *     rather than repeating one.
 *   - Only in the person's waking hours (`RADAR_MOMENT_WINDOW`, their own time zone), so the
 *     5am pass that finds a moment does not buzz anyone's phone at 5am.
 *   - The email: at most one a local day, claimed on `radar_moment_last_day` with a single
 *     statement before sending (the Monday email's rule), only with the person's switch on.
 *   - Nothing names anyone where a lock screen could show it: the push says what kind of
 *     moment it is; the email subject only counts.
 *
 * Driven by the hourly Radar route (`/api/radar/run`), after the pass. That route stands down
 * entirely while Radar is hidden or coming soon, so these do too.
 */
import { sql } from "drizzle-orm";
import { getDb, rowsOf } from "@/db";
import { getAppBaseUrl } from "@/lib/app-url";
import { bucketCount, consumeBucket } from "@/lib/rate-limit";
import { sendPushToUser, type PushPayload, type PushTransport } from "@/lib/push";
import {
  localClock,
  radarDigestConfigured,
  radarMomentUnsubscribeUrl,
  reportRefusal,
  resendDeliver,
  type DigestDeliver,
  type DigestReport,
} from "@/lib/radar/digest";
import { buildRadarMomentEmail } from "@/lib/radar/digest-email";
import { digestLineFor } from "@/lib/radar/email-text";
import type { RadarReason, RecommendationKind } from "@/lib/radar/types";

/** Local hours [from, to) in which an alert may go out. */
export const RADAR_MOMENT_WINDOW = { fromHour: 8, toHour: 20 } as const;
export const RADAR_ALERTS_PER_DAY = 2;
export const RADAR_ALERT_DAY_SCOPE = "radar-alert-day";
export const RADAR_ALERT_CARD_SCOPE = "radar-alert-card";
const DAY_POLICY = { limit: RADAR_ALERTS_PER_DAY, windowSec: 2 * 86_400 };
const CARD_POLICY = { limit: 1, windowSec: 30 * 86_400 };
/** Today cards read per person; more than the daily cap, so already-alerted ones can be skipped. */
const TODAY_READ = 6;
const BATCH = 200;
export const RADAR_MOMENTS_BUDGET_MS = 60_000;

export type MomentCard = { id: string; kind: RecommendationKind; name: string; line: string; hasDraft: boolean };

/** What a push says: the kind of moment, never who. A lock screen shows it to anyone nearby. */
export function momentPushText(card: Pick<MomentCard, "id" | "kind">): PushPayload {
  const url = `/radar?focus=${encodeURIComponent(card.id)}`;
  const t = (title: string, body: string): PushPayload => ({ title, body, url, kind: "radar_moment" });
  switch (card.kind) {
    case "follow_up":
      return t("A reply you owe, today", "Someone is waiting on you. Open Radar to see who.");
    case "prep":
      return t("Someone you’re seeing soon", "A minute of prep before you meet. Open Radar.");
    case "heads_up":
      return t("News about someone you know", "A good moment to reach out. Open Radar.");
    case "opportunity":
      return t("An opening worth a look", "Someone you know could help. Open Radar.");
    case "introduce":
    case "ask":
    case "share":
      return t("A connection worth making", "Two people you know should meet. Open Radar.");
    default:
      return t("Someone worth a message today", "It won’t keep. Open Radar to see who.");
  }
}

/** Today's cards for one person, best first. */
async function loadTodayCards(userId: string): Promise<MomentCard[]> {
  const db = await getDb();
  const rows = rowsOf<{
    id: string;
    kind: RecommendationKind;
    reasons: RadarReason[] | null;
    why: string | null;
    has_draft: boolean | null;
    full_name: string;
    preferred_name: string | null;
  }>(
    await db.execute(sql`
      SELECT r.id, r.kind, r.reasons,
             CASE WHEN r.ai_note ->> 'inputsHash' = r.inputs_hash THEN r.ai_note ->> 'why' END AS why,
             (r.draft ->> 'inputsHash' = r.inputs_hash) AS has_draft,
             c.full_name, c.preferred_name
        FROM recommendations r
        JOIN contacts c ON c.id = r.contact_id AND c.user_id = r.user_id
       WHERE r.user_id = ${userId} AND r.status = 'pending' AND r.bucket = 'today' AND r.expires_at > now()
       ORDER BY r.score DESC, r.id
       LIMIT ${TODAY_READ}
    `)
  );
  return rows.map((r) => ({
    id: r.id,
    kind: r.kind,
    name: (r.preferred_name ?? "").trim() || r.full_name,
    // The same withholding as the Monday email: a card built from mail never quotes it.
    line: digestLineFor(r.why, r.reasons ?? []),
    hasDraft: r.has_draft === true,
  }));
}

type Candidate = { user_id: string; email: string | null; tz: string; email_on: number; last_day: string | null };

async function candidates(after: string): Promise<Candidate[]> {
  const db = await getDb();
  return rowsOf<Candidate>(
    await db.execute(sql`
      SELECT s.user_id, s.email, coalesce(s.radar_digest_tz, 'UTC') AS tz,
             s.radar_moment_email_enabled AS email_on, s.radar_moment_last_day AS last_day
        FROM user_settings s
       WHERE s.radar_enabled_at IS NOT NULL
         AND s.radar_paused = 0
         AND s.suspended_at IS NULL
         AND s.user_id > ${after}
         AND EXISTS (
           SELECT 1 FROM recommendations r
            WHERE r.user_id = s.user_id AND r.status = 'pending' AND r.bucket = 'today' AND r.expires_at > now()
         )
       ORDER BY s.user_id
       LIMIT ${BATCH}
    `)
  );
}

/**
 * The cards this run may alert about for one person: not alerted before, and within what is
 * left of today's allowance. Spends both buckets for each card it returns.
 */
export async function claimMomentCards(userId: string, ymd: string, cards: readonly MomentCard[]): Promise<MomentCard[]> {
  const dayKey = `${userId}:${ymd}`;
  let room = RADAR_ALERTS_PER_DAY - (await bucketCount(RADAR_ALERT_DAY_SCOPE, dayKey, DAY_POLICY));
  const picked: MomentCard[] = [];
  for (const card of cards) {
    if (room <= 0) break;
    if ((await bucketCount(RADAR_ALERT_CARD_SCOPE, `${userId}:${card.id}`, CARD_POLICY)) > 0) continue;
    try {
      await consumeBucket(RADAR_ALERT_CARD_SCOPE, `${userId}:${card.id}`, CARD_POLICY);
      await consumeBucket(RADAR_ALERT_DAY_SCOPE, dayKey, DAY_POLICY);
    } catch {
      // A bucket already full (another run got here first): this card is not ours to send.
      continue;
    }
    picked.push(card);
    room--;
  }
  return picked;
}

/** The day's email claim: one statement, won once per local day, and only with the switch on. */
async function claimMomentEmailDay(userId: string, ymd: string): Promise<{ prev: string | null } | undefined> {
  const db = await getDb();
  const [row] = rowsOf<{ prev: string | null }>(
    await db.execute(sql`
      UPDATE user_settings u
         SET radar_moment_last_day = ${ymd}
        FROM (SELECT radar_moment_last_day AS prev FROM user_settings WHERE user_id = ${userId}) p
       WHERE u.user_id = ${userId}
         AND u.radar_moment_email_enabled = 1
         AND u.radar_moment_last_day IS DISTINCT FROM ${ymd}
      RETURNING p.prev
    `)
  );
  return row ? { prev: row.prev } : undefined;
}

async function releaseMomentEmailDay(userId: string, ymd: string, prev: string | null) {
  const db = await getDb();
  await db.execute(sql`UPDATE user_settings SET radar_moment_last_day = ${prev} WHERE user_id = ${userId} AND radar_moment_last_day = ${ymd}`);
}

export type RadarMomentStats = { people: number; alerted: number; pushed: number; emailed: number; failed: number; budgetExhausted: boolean };

export async function sendRadarMoments(
  now: Date = new Date(),
  opts: { push?: PushTransport; deliver?: DigestDeliver; report?: DigestReport; budgetMs?: number } = {}
): Promise<RadarMomentStats> {
  const stats: RadarMomentStats = { people: 0, alerted: 0, pushed: 0, emailed: 0, failed: 0, budgetExhausted: false };
  const deliver = opts.deliver ?? (radarDigestConfigured() ? resendDeliver : null);
  const report = opts.report ?? reportRefusal;
  const deadline = Date.now() + (opts.budgetMs ?? RADAR_MOMENTS_BUDGET_MS);
  const appUrl = getAppBaseUrl();
  let reported = false;
  let cursor = "";
  for (;;) {
    const batch = await candidates(cursor);
    for (const person of batch) {
      cursor = person.user_id;
      if (Date.now() >= deadline) {
        stats.budgetExhausted = true;
        return stats;
      }
      const clock = localClock(now, person.tz);
      if (clock.hour < RADAR_MOMENT_WINDOW.fromHour || clock.hour >= RADAR_MOMENT_WINDOW.toHour) continue;
      const cards = await claimMomentCards(person.user_id, clock.ymd, await loadTodayCards(person.user_id));
      if (cards.length === 0) continue;
      stats.people++;
      stats.alerted += cards.length;
      for (const card of cards) {
        const r = await sendPushToUser(person.user_id, momentPushText(card), opts.push);
        stats.pushed += r.sent;
      }
      const email = person.email?.trim();
      if (!deliver || !email || person.email_on !== 1 || person.last_day === clock.ymd) continue;
      const claim = await claimMomentEmailDay(person.user_id, clock.ymd);
      if (!claim) continue;
      const unsubscribeUrl = radarMomentUnsubscribeUrl(person.user_id);
      const message = buildRadarMomentEmail(cards, { appUrl, unsubscribeUrl });
      const result = await deliver({ to: email, ...message, unsubscribeUrl });
      if (result.ok) {
        stats.emailed++;
        continue;
      }
      stats.failed++;
      await releaseMomentEmailDay(person.user_id, clock.ymd, claim.prev);
      if (!reported) {
        reported = true;
        await report({ userId: person.user_id, error: result.error ?? "Send refused." });
      }
    }
    if (batch.length < BATCH) break;
  }
  return stats;
}
