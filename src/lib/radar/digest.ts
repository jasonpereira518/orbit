/**
 * Radar's Monday email: the week's top people, sent once a week in each person's own
 * Monday morning.
 *
 * The cron (`/api/radar/digest`) runs hourly through Sunday and Monday UTC, which is what it
 * takes for every zone's Monday 06:00–09:00 to fall on a run: Auckland's Monday morning is
 * Sunday evening in UTC, Honolulu's is Monday afternoon. Each run finds the zones whose local
 * clock is in that window right now, and the people in them who have the email on, used Orbit
 * in the last month, and hold at least one card for today or soon.
 *
 * AT MOST ONCE A WEEK PER PERSON, which is the one thing this file must never get wrong. Each
 * person is claimed with a single statement that stamps the ISO week of their local Monday
 * (`radar_digest_last_week`) only if it isn't already stamped, before their message is
 * built: two overlapping runs cannot both win it, and a run that dies loses a send rather
 * than repeating one. A send Resend refuses releases the claim, so the next hour tries again.
 *
 * The timezone is the browser's, captured from the `orbit-tz` cookie when the person opens
 * Radar or Settings (`captureRadarTimeZone`); UTC until then.
 *
 * Unsubscribing is one click (RFC 8058) through `/api/radar/digest/unsubscribe`, with a token
 * that is an HMAC of the account id under a per-purpose key, so every week's email carries
 * the same working link without a secret being stored. Its hash is recorded when a digest is
 * claimed, and the route honours only a token whose hash matches: a link works for an account
 * that was actually sent one.
 */
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { sql } from "drizzle-orm";
import { getDb, rowsOf } from "@/db";
import { getAppBaseUrl } from "@/lib/app-url";
import { ERROR_SOURCES, recordErrorEvent } from "@/lib/error-events";
import { isValidTimeZone } from "@/lib/reminder-due-bucket";
import { buildRadarDigestEmail, type DigestContent } from "@/lib/radar/digest-email";
import { leadReason, type RadarReason, type RecommendationKind } from "@/lib/radar/types";

/** People shown in the email; the rest are counted. */
export const RADAR_DIGEST_TOP = 5;
/** People read per statement. The run keeps reading while it has time. */
export const RADAR_DIGEST_BATCH = 100;
/** The local window, [from, to) hours on Monday. Three hourly runs land inside it. */
export const RADAR_DIGEST_WINDOW = { fromHour: 6, toHour: 9 } as const;
export const RADAR_DIGEST_ACTIVE_DAYS = 30;
/** Stop starting sends after this, well inside the route's 300 s. */
export const RADAR_DIGEST_BUDGET_MS = 240_000;
/** Between sends, to stay under Resend's default of two requests a second. */
const SEND_GAP_MS = 550;
const DAY_MS = 86_400_000;

const UNSUBSCRIBE_LABEL = "orbit:radar-digest-unsubscribe:v1";

// ---- Time --------------------------------------------------------------------------------

const clockFormatters = new Map<string, Intl.DateTimeFormat>();

/** `now` on the wall clock of `tz`: the weekday (0 = Sunday), hour, and calendar day. */
export function localClock(now: Date, tz: string): { weekday: number; hour: number; ymd: string } {
  let fmt = clockFormatters.get(tz);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      weekday: "short",
      hour: "2-digit",
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
    clockFormatters.set(tz, fmt);
  }
  const parts = Object.fromEntries(fmt.formatToParts(now).map((p) => [p.type, p.value]));
  const weekday = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(parts.weekday ?? "");
  return { weekday, hour: Number(parts.hour) % 24, ymd: `${parts.year}-${parts.month}-${parts.day}` };
}

/** The ISO 8601 week of a calendar day, as "2026-W40". */
export function isoWeekOf(ymd: string): string {
  const [y, m, d] = ymd.split("-").map(Number);
  const date = new Date(Date.UTC(y!, m! - 1, d!));
  // Thursday decides the year a week belongs to.
  date.setUTCDate(date.getUTCDate() + 4 - (date.getUTCDay() || 7));
  const year = date.getUTCFullYear();
  const week = Math.ceil(((date.getTime() - Date.UTC(year, 0, 1)) / DAY_MS + 1) / 7);
  return `${year}-W${String(week).padStart(2, "0")}`;
}

/** Whether it is Monday morning in `tz`, inside the send window. */
export function inDigestWindow(now: Date, tz: string): boolean {
  const { weekday, hour } = localClock(now, tz);
  return weekday === 1 && hour >= RADAR_DIGEST_WINDOW.fromHour && hour < RADAR_DIGEST_WINDOW.toHour;
}

/**
 * Of these zones, the ones in the window now, grouped by the ISO week of their Monday. (One
 * group in practice: zones inside the same three-hour Monday window share a calendar day.)
 */
export function openDigestZones(now: Date, zones: readonly string[]): Map<string, string[]> {
  const byWeek = new Map<string, string[]>();
  for (const tz of zones) {
    if (!isValidTimeZone(tz) || !inDigestWindow(now, tz)) continue;
    const week = isoWeekOf(localClock(now, tz).ymd);
    byWeek.set(week, [...(byWeek.get(week) ?? []), tz]);
  }
  return byWeek;
}

/**
 * Remember the browser's zone for the Monday email. The cookie is untrusted input on its way
 * into a comparison, so only a zone this runtime recognizes is kept. One statement, and a
 * no-op when nothing changed.
 */
export async function captureRadarTimeZone(userId: string, raw: string | null | undefined): Promise<void> {
  if (!isValidTimeZone(raw)) return;
  const db = await getDb();
  await db.execute(sql`
    UPDATE user_settings SET radar_digest_tz = ${raw}
     WHERE user_id = ${userId} AND radar_digest_tz IS DISTINCT FROM ${raw}
  `);
}

// ---- Unsubscribe -------------------------------------------------------------------------

function unsubscribeKey(): Buffer {
  // ENCRYPTION_SECRET is required in production (src/lib/env.ts); the fallback is dev-only.
  const secret = process.env.ENCRYPTION_SECRET || "orbit-dev-radar-digest";
  return createHmac("sha256", secret).update(UNSUBSCRIBE_LABEL).digest();
}

export function radarDigestUnsubscribeToken(userId: string): string {
  const id = Buffer.from(userId, "utf8").toString("base64url");
  const mac = createHmac("sha256", unsubscribeKey()).update(id).digest("base64url");
  return `${id}.${mac}`;
}

/** The account a token was issued for, or null when it is not one this app signed. */
export function readRadarDigestUnsubscribeToken(token: string | null | undefined): string | null {
  if (!token || token.length > 400) return null;
  const [id, mac, extra] = token.split(".");
  if (!id || !mac || extra !== undefined) return null;
  const expected = Buffer.from(createHmac("sha256", unsubscribeKey()).update(id).digest("base64url"));
  const given = Buffer.from(mac);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  const userId = Buffer.from(id, "base64url").toString("utf8");
  return userId || null;
}

export function hashRadarDigestToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function radarDigestUnsubscribeUrl(token: string): string {
  return `${getAppBaseUrl()}/api/radar/digest/unsubscribe?token=${encodeURIComponent(token)}`;
}

/**
 * Turn the email off for the account a token names. Returns false for a token that does not
 * verify or was never issued. Idempotent: a second click finds it already off.
 */
export async function unsubscribeRadarDigest(token: string | null | undefined): Promise<boolean> {
  const userId = readRadarDigestUnsubscribeToken(token);
  if (!userId || !token) return false;
  const db = await getDb();
  const rows = rowsOf<{ user_id: string }>(
    await db.execute(sql`
      UPDATE user_settings SET radar_digest_enabled = 0
       WHERE user_id = ${userId} AND radar_digest_unsub_token_hash = ${hashRadarDigestToken(token)}
      RETURNING user_id
    `)
  );
  return rows.length > 0;
}

// ---- Sending -----------------------------------------------------------------------------

export type DigestMessage = { to: string; subject: string; html: string; text: string; unsubscribeUrl: string };
export type DigestDeliver = (message: DigestMessage) => Promise<{ ok: boolean; error?: string }>;
/** Where a refused send is recorded: the error log, which the ops sweep alerts on. */
export type DigestReport = (failure: { userId: string; error: string }) => Promise<void>;

const reportRefusal: DigestReport = ({ userId, error }) =>
  recordErrorEvent({
    source: ERROR_SOURCES.resendRejected,
    kind: "radar.digest",
    userId,
    message: error,
    context: { phase: "rejected" },
  });

/** The app's sender, named "Orbit" when it is a bare address; the same one the invitation uses. */
export function radarDigestSender(): string | null {
  const configured = process.env.RESEND_FROM_EMAIL?.trim();
  if (!configured) return null;
  return configured.includes("<") ? configured : `Orbit <${configured}>`;
}

export function radarDigestConfigured(): boolean {
  return Boolean(process.env.RESEND_API_KEY?.trim() && radarDigestSender());
}

const resendDeliver: DigestDeliver = async (message) => {
  const apiKey = process.env.RESEND_API_KEY?.trim();
  const from = radarDigestSender();
  if (!apiKey || !from) return { ok: false, error: "Resend is not configured." };
  try {
    // Loaded on send: the SDK stays off every cold start that sends nothing.
    const { Resend } = await import("resend");
    const { error } = await new Resend(apiKey).emails.send({
      from,
      to: message.to,
      subject: message.subject,
      html: message.html,
      text: message.text,
      headers: {
        "List-Unsubscribe": `<${message.unsubscribeUrl}>`,
        "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
      },
    });
    return error ? { ok: false, error: error.message } : { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Send threw." };
  }
};

/** What one person's email says, or null when they no longer have a card to mention. */
export async function loadDigestContent(userId: string): Promise<DigestContent | null> {
  const db = await getDb();
  const rows = rowsOf<{
    id: string;
    kind: RecommendationKind;
    reasons: RadarReason[] | null;
    why: string | null;
    has_draft: boolean | null;
    full_name: string;
    preferred_name: string | null;
    company: string | null;
    total: number | string;
    drafts: number | string;
  }>(
    await db.execute(sql`
      SELECT r.id, r.kind, r.reasons,
             CASE WHEN r.ai_note ->> 'inputsHash' = r.inputs_hash THEN r.ai_note ->> 'why' END AS why,
             (r.draft ->> 'inputsHash' = r.inputs_hash) AS has_draft,
             c.full_name, c.preferred_name, c.company,
             count(*) OVER () AS total,
             count(*) FILTER (WHERE r.draft ->> 'inputsHash' = r.inputs_hash) OVER () AS drafts
        FROM recommendations r
        JOIN contacts c ON c.id = r.contact_id AND c.user_id = r.user_id
       WHERE r.user_id = ${userId}
         AND r.status = 'pending'
         AND r.bucket IN ('today', 'soon')
         AND r.expires_at > now()
       ORDER BY (r.bucket = 'today') DESC, r.score DESC, r.id
       LIMIT ${RADAR_DIGEST_TOP}
    `)
  );
  if (rows.length === 0) return null;
  return {
    total: Number(rows[0]!.total),
    drafts: Number(rows[0]!.drafts),
    people: rows.map((r) => ({
      id: r.id,
      name: (r.preferred_name ?? "").trim() || r.full_name,
      kind: r.kind,
      company: r.company?.trim() || null,
      line: r.why?.trim() || leadReason(r.reasons ?? [])?.label || "Worth a message this week",
      hasDraft: r.has_draft === true,
    })),
  };
}

export type RadarDigestStats = {
  /** Zones in the Monday window this run. */
  zones: number;
  eligible: number;
  claimed: number;
  sent: number;
  failed: number;
  /** Claimed, but their cards had gone by the time the message was built. */
  empty: number;
  budgetExhausted: boolean;
};

async function openZones(now: Date): Promise<Map<string, string[]>> {
  const db = await getDb();
  const rows = rowsOf<{ tz: string }>(
    await db.execute(sql`
      SELECT DISTINCT coalesce(radar_digest_tz, 'UTC') AS tz
        FROM user_settings
       WHERE radar_digest_enabled = 1 AND radar_paused = 0
    `)
  );
  return openDigestZones(now, rows.map((r) => r.tz));
}

async function eligibleBatch(
  zones: readonly string[],
  week: string,
  after: string,
  now: Date
): Promise<Array<{ user_id: string; email: string }>> {
  const db = await getDb();
  const activeSince = new Date(now.getTime() - RADAR_DIGEST_ACTIVE_DAYS * DAY_MS).toISOString();
  return rowsOf<{ user_id: string; email: string }>(
    await db.execute(sql`
      SELECT s.user_id, s.email
        FROM user_settings s
       WHERE s.radar_digest_enabled = 1
         AND s.radar_paused = 0
         AND s.suspended_at IS NULL
         AND s.email IS NOT NULL AND btrim(s.email) <> ''
         AND coalesce(s.radar_digest_tz, 'UTC') IN (${sql.join(zones.map((z) => sql`${z}`), sql`, `)})
         AND s.radar_digest_last_week IS DISTINCT FROM ${week}
         AND s.last_active_at > ${activeSince}::timestamptz
         AND s.user_id > ${after}
         AND EXISTS (
           SELECT 1 FROM recommendations r
            WHERE r.user_id = s.user_id AND r.status = 'pending'
              AND r.bucket IN ('today', 'soon') AND r.expires_at > now()
         )
       ORDER BY s.user_id
       LIMIT ${RADAR_DIGEST_BATCH}
    `)
  );
}

/**
 * The week claim: one statement, won by exactly one caller. Returns the week it replaced
 * (so a failed send can put it back), or undefined when someone else already has it or the
 * person turned the email off meanwhile.
 */
export async function claimRadarDigestWeek(
  userId: string,
  week: string,
  tokenHash: string
): Promise<{ prev: string | null } | undefined> {
  const db = await getDb();
  const [row] = rowsOf<{ prev: string | null }>(
    await db.execute(sql`
      UPDATE user_settings u
         SET radar_digest_last_week = ${week}, radar_digest_unsub_token_hash = ${tokenHash}
        FROM (SELECT radar_digest_last_week AS prev FROM user_settings WHERE user_id = ${userId}) p
       WHERE u.user_id = ${userId}
         AND u.radar_digest_enabled = 1
         AND u.radar_digest_last_week IS DISTINCT FROM ${week}
      RETURNING p.prev
    `)
  );
  return row ? { prev: row.prev } : undefined;
}

async function releaseRadarDigestWeek(userId: string, week: string, prev: string | null): Promise<void> {
  const db = await getDb();
  await db.execute(sql`
    UPDATE user_settings SET radar_digest_last_week = ${prev}
     WHERE user_id = ${userId} AND radar_digest_last_week = ${week}
  `);
}

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * One run: every person whose Monday morning it is, not yet sent this week, up to the budget.
 * Never throws for one person's failure; the caller records the stats.
 */
export async function sendRadarDigests(
  now: Date = new Date(),
  opts: { deliver?: DigestDeliver; report?: DigestReport; budgetMs?: number; gapMs?: number } = {}
): Promise<RadarDigestStats> {
  const deliver = opts.deliver ?? resendDeliver;
  const report = opts.report ?? reportRefusal;
  const deadline = Date.now() + (opts.budgetMs ?? RADAR_DIGEST_BUDGET_MS);
  const gapMs = opts.gapMs ?? SEND_GAP_MS;
  const appUrl = getAppBaseUrl();
  const stats: RadarDigestStats = { zones: 0, eligible: 0, claimed: 0, sent: 0, failed: 0, empty: 0, budgetExhausted: false };
  let reportedFailure = false;
  let sentAny = false;

  for (const [week, zones] of await openZones(now)) {
    stats.zones += zones.length;
    let cursor = "";
    for (;;) {
      const batch = await eligibleBatch(zones, week, cursor, now);
      stats.eligible += batch.length;
      for (const person of batch) {
        cursor = person.user_id;
        if (Date.now() >= deadline) {
          stats.budgetExhausted = true;
          return stats;
        }
        const token = radarDigestUnsubscribeToken(person.user_id);
        const claim = await claimRadarDigestWeek(person.user_id, week, hashRadarDigestToken(token));
        if (!claim) continue;
        stats.claimed++;
        const content = await loadDigestContent(person.user_id);
        if (!content) {
          stats.empty++;
          continue;
        }
        const unsubscribeUrl = radarDigestUnsubscribeUrl(token);
        const message = buildRadarDigestEmail(content, { appUrl, unsubscribeUrl });
        if (sentAny && gapMs > 0) await pause(gapMs);
        sentAny = true;
        const result = await deliver({ to: person.email.trim(), ...message, unsubscribeUrl });
        if (result.ok) {
          stats.sent++;
          continue;
        }
        stats.failed++;
        await releaseRadarDigestWeek(person.user_id, week, claim.prev);
        // Once per run: when Resend is down, every send fails the same way.
        if (!reportedFailure) {
          reportedFailure = true;
          await report({ userId: person.user_id, error: result.error ?? "Send refused." });
        }
      }
      if (batch.length < RADAR_DIGEST_BATCH) break;
    }
  }
  return stats;
}
