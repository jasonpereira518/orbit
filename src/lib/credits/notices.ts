import { createHmac, timingSafeEqual } from "node:crypto";
import { sql } from "drizzle-orm";
import { getDb, rowsOf } from "@/db";
import { getAppBaseUrl } from "@/lib/app-url";
import { getCreditBalance } from "@/lib/credits/ledger";
import { MICROS_PER_CREDIT } from "@/lib/credits/grants";
import { getEntitlements } from "@/lib/entitlements";
import { ERROR_SOURCES, recordErrorEvent } from "@/lib/error-events";
import { escapeHtml } from "@/lib/interest-list-email";
import { PLAN_LABELS, type Plan } from "@/lib/plans/plan-config";
import { CREDIT_PACK_CREDITS, CREDIT_PACK_PRICE_CENTS } from "@/lib/stripe-config";

/**
 * The emails at 80% and 100% of an account's monthly AI credits (pricing v2). The in-app
 * notices (`plan.credits_near` / `credits_on_packs` / `credits_out` in account-alerts.ts) say
 * the same thing to someone who is looking; these reach someone who is not.
 *
 *  - Driven by the ten-minute schedule (`/api/credits/notices`, .github/workflows/ops.yml): it
 *    looks at allowance grants, never at the AI call path, so no request waits on an email.
 *  - At most once per level per allowance cycle. Each send is CLAIMED first, in one UPDATE
 *    that records the cycle and level, so overlapping runs cannot double-send; a send Resend
 *    refuses puts the claim back, and the next run tries again.
 *  - Crossing both levels between two runs sends only the 100% email.
 *  - One-click unsubscribe (RFC 8058) through `/api/credits/email/unsubscribe`, with a token
 *    that is an HMAC of the account id; the Settings switch turns it back on.
 *
 * No `next/server`: the route and the smoke both drive this.
 */

export type NoticeLevel = 80 | 100;

/** The level an allowance has reached, or 0 below 80% used. */
export function noticeLevelFor(grantedMicros: number, remainingMicros: number): 0 | NoticeLevel {
  if (grantedMicros <= 0) return 0;
  const used = grantedMicros - remainingMicros;
  if (used >= grantedMicros) return 100;
  if (used * 5 >= grantedMicros * 4) return 80;
  return 0;
}

// ---- Unsubscribe -------------------------------------------------------------------------

const UNSUBSCRIBE_LABEL = "orbit:credit-email-unsubscribe:v1";

function unsubscribeKey(): Buffer {
  // ENCRYPTION_SECRET is required in production (src/lib/env.ts); the fallback is dev-only.
  const secret = process.env.ENCRYPTION_SECRET || "orbit-dev-credit-email";
  return createHmac("sha256", secret).update(UNSUBSCRIBE_LABEL).digest();
}

export function creditEmailUnsubscribeToken(userId: string): string {
  const id = Buffer.from(userId, "utf8").toString("base64url");
  const mac = createHmac("sha256", unsubscribeKey()).update(id).digest("base64url");
  return `${id}.${mac}`;
}

/** The account a token was issued for, or null when this app did not sign it. */
export function readCreditEmailUnsubscribeToken(token: string | null | undefined): string | null {
  if (!token || token.length > 400) return null;
  const [id, mac, extra] = token.split(".");
  if (!id || !mac || extra !== undefined) return null;
  const expected = Buffer.from(createHmac("sha256", unsubscribeKey()).update(id).digest("base64url"));
  const given = Buffer.from(mac);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  return Buffer.from(id, "base64url").toString("utf8") || null;
}

export function creditEmailUnsubscribeUrl(userId: string): string {
  return `${getAppBaseUrl()}/api/credits/email/unsubscribe?token=${encodeURIComponent(creditEmailUnsubscribeToken(userId))}`;
}

/** Turn the emails off for the account a token names. Idempotent; false for a bad token. */
export async function unsubscribeCreditEmail(token: string | null | undefined): Promise<boolean> {
  const userId = readCreditEmailUnsubscribeToken(token);
  if (!userId) return false;
  const db = await getDb();
  const rows = rowsOf<{ user_id: string }>(
    await db.execute(sql`
      UPDATE user_settings SET credit_email_enabled = 0 WHERE user_id = ${userId} RETURNING user_id
    `)
  );
  return rows.length > 0;
}

// ---- The message -------------------------------------------------------------------------

export type CreditNotice = {
  level: NoticeLevel;
  plan: Plan;
  grantedCredits: number;
  usedCredits: number;
  /** Pack credits this plan can spend right now (0 when frozen or none). */
  packCredits: number;
  resetsAt: Date;
};

export type CreditEmail = { subject: string; html: string; text: string };

function day(d: Date): string {
  return d.toLocaleDateString("en-US", { month: "long", day: "numeric", timeZone: "UTC" });
}

/** The email, in the app's own voice: what happened, when it resets, and the choices. */
export function buildCreditEmail(notice: CreditNotice, unsubscribeUrl: string): CreditEmail {
  const plan = PLAN_LABELS[notice.plan];
  const pack = `$${(CREDIT_PACK_PRICE_CENTS / 100).toFixed(0)} pack of ${CREDIT_PACK_CREDITS} credits`;
  const resets = day(notice.resetsAt);
  const options = [
    `add a ${pack}`,
    ...(notice.plan === "orbit" ? ["move to Orbit Max, which includes 500 credits a month"] : []),
    "switch to your own AI key, which never uses credits",
  ];
  const choices = `${options.slice(0, -1).join(", ")}, or ${options.at(-1)}`;

  let subject: string;
  let lines: string[];
  if (notice.level === 80) {
    subject = "You’ve used 80% of this month’s AI credits";
    lines = [
      `You’ve used ${notice.usedCredits} of the ${notice.grantedCredits} AI credits included with ${plan} this month. They reset on ${resets}.`,
      `If you run out before then, included AI pauses until they reset — Orbit never charges you automatically. To keep going, you can ${choices}.`,
    ];
  } else if (notice.packCredits > 0) {
    subject = "Your monthly AI credits are used up — now using your pack credits";
    lines = [
      `You’ve used all ${notice.grantedCredits} AI credits included with ${plan} this month, so Orbit is now using your pack credits. You have ${notice.packCredits} left.`,
      `Your monthly credits come back on ${resets}. Nothing is charged automatically.`,
    ];
  } else {
    subject = "Your AI credits for this month are used up";
    lines = [
      `You’ve used all ${notice.grantedCredits} AI credits included with ${plan} this month, so included AI is paused until ${resets}, when they come back. Everything else in Orbit keeps working.`,
      `To keep using AI now, you can ${choices}. Nothing is charged automatically.`,
    ];
  }

  const cta = `${getAppBaseUrl()}/settings?integration=ai`;
  const footer = "You get this email when your Orbit AI credits run low.";
  const text = [...lines, "", `See your credits: ${cta}`, "", `${footer} Turn it off: ${unsubscribeUrl}`].join("\n");
  const html = `<!doctype html>
<html>
  <body style="margin:0;padding:0;background-color:#f6f7f6;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
      <tr><td align="center" style="padding:32px 16px;">
        <table role="presentation" width="520" cellpadding="0" cellspacing="0" style="max-width:520px;width:100%;background:#ffffff;border-radius:14px;">
          <tr><td style="padding:28px 28px 8px;font-size:18px;font-weight:600;color:#10201d;">${escapeHtml(subject)}</td></tr>
          ${lines
            .map((line) => `<tr><td style="padding:8px 28px;font-size:15px;line-height:1.6;color:#3a4a47;">${escapeHtml(line)}</td></tr>`)
            .join("\n          ")}
          <tr><td style="padding:18px 28px 28px;">
            <a href="${escapeHtml(cta)}" style="display:inline-block;font-size:15px;font-weight:600;color:#ffffff;background:#1f4d47;border-radius:10px;padding:11px 20px;text-decoration:none;">See your credits</a>
          </td></tr>
        </table>
        <p style="max-width:520px;margin:16px auto 0;font-size:12px;line-height:1.5;color:#7a8a87;">
          ${escapeHtml(footer)} <a href="${escapeHtml(unsubscribeUrl)}" style="color:#7a8a87;">Turn it off</a>
        </p>
      </td></tr>
    </table>
  </body>
</html>`;
  return { subject, html, text };
}

// ---- Sending -----------------------------------------------------------------------------

export type CreditEmailMessage = CreditEmail & { to: string; unsubscribeUrl: string };
export type CreditEmailDeliver = (message: CreditEmailMessage) => Promise<{ ok: boolean; error?: string }>;

function sender(): string | null {
  const configured = process.env.RESEND_FROM_EMAIL?.trim();
  if (!configured) return null;
  return configured.includes("<") ? configured : `Orbit <${configured}>`;
}

export function creditEmailConfigured(): boolean {
  return Boolean(process.env.RESEND_API_KEY?.trim() && sender());
}

const resendDeliver: CreditEmailDeliver = async (message) => {
  const apiKey = process.env.RESEND_API_KEY?.trim();
  const from = sender();
  if (!apiKey || !from) return { ok: false, error: "Resend is not configured." };
  try {
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

type Candidate = {
  user_id: string;
  email: string;
  period_start: Date | string;
  period_end: Date | string;
  granted: number;
  remaining: number;
  last_period: Date | string | null;
  last_level: number;
};

/**
 * Claim this cycle's level for one account: one statement, so of two overlapping runs only
 * one gets a row back. Returns what it replaced, for the release.
 */
async function claim(userId: string, periodStart: Date, level: NoticeLevel) {
  const db = await getDb();
  const [row] = rowsOf<{ prev_period: Date | string | null; prev_level: number }>(
    await db.execute(sql`
      UPDATE user_settings u
         SET credit_notice_period_start = ${periodStart}, credit_notice_level = ${level}
        FROM (SELECT credit_notice_period_start AS prev_period, credit_notice_level AS prev_level
                FROM user_settings WHERE user_id = ${userId}) p
       WHERE u.user_id = ${userId}
         AND u.credit_email_enabled = 1
         AND (u.credit_notice_period_start IS DISTINCT FROM ${periodStart} OR u.credit_notice_level < ${level})
      RETURNING p.prev_period, p.prev_level
    `)
  );
  return row;
}

async function release(userId: string, periodStart: Date, level: NoticeLevel, prev: { prev_period: Date | string | null; prev_level: number }) {
  const db = await getDb();
  const prevPeriod = prev.prev_period === null ? null : new Date(prev.prev_period);
  await db.execute(sql`
    UPDATE user_settings
       SET credit_notice_period_start = ${prevPeriod}, credit_notice_level = ${prev.prev_level}
     WHERE user_id = ${userId} AND credit_notice_period_start = ${periodStart} AND credit_notice_level = ${level}
  `);
}

export type CreditNoticeStats = { candidates: number; sent: number; skipped: number; failed: number };

/**
 * One run: every account whose current allowance has crossed a level it has not been emailed
 * for this cycle. `deliver` and `now` are injectable for the smoke.
 */
export async function sendCreditNotices(
  opts: { deliver?: CreditEmailDeliver; now?: Date; limit?: number; pauseMs?: number } = {}
): Promise<CreditNoticeStats> {
  const deliver = opts.deliver ?? resendDeliver;
  const now = opts.now ?? new Date();
  const db = await getDb();
  const candidates = rowsOf<Candidate>(
    await db.execute(sql`
      SELECT s.user_id, s.email, g.period_start, g.period_end,
             g.micros_granted AS granted, g.micros_remaining AS remaining,
             s.credit_notice_period_start AS last_period, s.credit_notice_level AS last_level
        FROM credit_grants g
        JOIN user_settings s ON s.user_id = g.user_id
       WHERE g.kind = 'allowance' AND g.status = 'active'
         AND g.period_start <= ${now} AND g.period_end > ${now}
         AND g.micros_granted > 0
         AND (g.micros_granted - g.micros_remaining) * 5 >= g.micros_granted * 4
         AND s.credit_email_enabled = 1
         AND coalesce(trim(s.email), '') <> ''
       ORDER BY g.period_start
       LIMIT ${opts.limit ?? 150}
    `)
  );

  const stats: CreditNoticeStats = { candidates: candidates.length, sent: 0, skipped: 0, failed: 0 };
  for (const c of candidates) {
    const periodStart = new Date(c.period_start);
    const level = noticeLevelFor(Number(c.granted), Number(c.remaining));
    const sameCycle = c.last_period !== null && new Date(c.last_period).getTime() === periodStart.getTime();
    if (level === 0 || (sameCycle && Number(c.last_level) >= level)) {
      stats.skipped++;
      continue;
    }
    // Only an account still on included AI hears about its credits.
    const ent = await getEntitlements(c.user_id);
    if (!ent.canUseHostedAi) {
      stats.skipped++;
      continue;
    }
    const prev = await claim(c.user_id, periodStart, level);
    if (!prev) {
      stats.skipped++;
      continue;
    }
    const balance = await getCreditBalance(c.user_id, ent.plan, null, now, { ensure: false });
    const packCredits = balance.packsFrozen ? 0 : Math.floor(balance.packRemaining / MICROS_PER_CREDIT);
    const unsubscribeUrl = creditEmailUnsubscribeUrl(c.user_id);
    const email = buildCreditEmail(
      {
        level,
        plan: ent.plan,
        grantedCredits: Math.round(Number(c.granted) / MICROS_PER_CREDIT),
        usedCredits: Math.round((Number(c.granted) - Number(c.remaining)) / MICROS_PER_CREDIT),
        packCredits,
        resetsAt: new Date(c.period_end),
      },
      unsubscribeUrl
    );
    const result = await deliver({ to: c.email.trim(), ...email, unsubscribeUrl });
    if (result.ok) {
      stats.sent++;
    } else {
      stats.failed++;
      await release(c.user_id, periodStart, level, prev);
      await recordErrorEvent({
        source: ERROR_SOURCES.resendRejected,
        kind: "credits.notice",
        userId: c.user_id,
        message: result.error ?? "refused",
        context: { phase: "rejected", level },
      });
    }
    // Under Resend's default of two requests a second.
    if (opts.pauseMs !== 0) await new Promise((r) => setTimeout(r, opts.pauseMs ?? 600));
  }
  return stats;
}
