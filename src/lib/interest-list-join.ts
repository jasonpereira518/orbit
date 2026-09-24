/**
 * The waitlist join, minus the request. `src/actions/interest-list.ts` reads the
 * headers and the attribution cookie and hands them in here, so this can run from a smoke
 * script with a fake IP and a recording mail sender.
 *
 * WHAT A CALLER LEARNS. Every path that does not end in a visible validation error returns
 * `ok`. A real join, an unsubscribed address rejoining, a bot and a rate-limited caller
 * all get a ticket of the same shape, so which check a submit tripped is not inferable
 * from the response.
 *
 * An address ALREADY on the list gets `emailed` instead: its pass goes to its inbox, never
 * onto the screen. It used to come back as the real ticket, which handed anyone who knew
 * an address that person's pass and invite link. Membership of an address is still
 * inferable, as it was before (see the spec's privacy section) — probed at ten tries per
 * ten minutes per IP, and the pass email itself is capped per address
 * (`RATE_LIMITS.interestPassEmail`) so the form cannot be used to fill a stranger's inbox.
 */
import { createHash } from "node:crypto";
import { and, eq, isNull, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { interestListSignups } from "@/db/schema";
import { getWaitlistPageUrl } from "@/lib/app-url";
import { ipLogTag } from "@/lib/log-redaction";
import type { Attribution } from "@/lib/attribution-parse";
import {
  FOUNDING_REFERRALS,
  FRONT_WAVE_REFERRALS,
  MIN_FILL_MS,
  buildShareUrl,
  buildTicketUrl,
  interestListSchema,
  type InterestListInput,
  type InterestListResult,
  type InterestTicket,
  type PassEmailResult,
} from "@/lib/interest-list";
import {
  buildUnsubscribeUrl,
  generateUnsubscribeToken,
  sendFoundingEmail,
  sendFriendJoinedEmail,
  sendFrontWaveEmail,
  sendInterestListWelcomeEmail,
  sendPassEmail,
  type EmailLinks,
} from "@/lib/interest-list-email";
import {
  getInterestProof,
  invalidateInterestProof,
  ticketForRow,
} from "@/lib/interest-list-ticket";
import { RATE_LIMITS, consumeBucket, isRateLimitedError } from "@/lib/rate-limit";
import { asWelcomePlanet, planetForSignupNumber, type WelcomePlanet } from "@/lib/welcome-planets";

export type WelcomeSender = (
  email: string,
  unsubscribeUrl: string,
  planet: WelcomePlanet,
  links: EmailLinks,
  /** Place in line, or null when it could not be counted. */
  position: number | null
) => Promise<unknown>;

/** Mails a referrer whose friends just carried them into a tier (front wave, founding). */
export type FrontWaveSender = (
  email: string,
  unsubscribeUrl: string,
  planet: WelcomePlanet,
  links: EmailLinks
) => Promise<unknown>;

/** Mails a referrer that one more friend joined; `referrals` includes that friend. */
export type FriendJoinedSender = (
  email: string,
  unsubscribeUrl: string,
  planet: WelcomePlanet,
  links: EmailLinks,
  referrals: number
) => Promise<unknown>;

export type JoinContext = {
  /** Rate-limit key. The action derives it from x-forwarded-for. */
  ip: string;
  attribution: Attribution | null;
  /** Injected by the smoke test; defaults to the real Resend send. */
  sendWelcome?: WelcomeSender;
  /** Injected by the smoke test; defaults to the real Resend send. */
  sendFrontWave?: FrontWaveSender;
  /** Injected by the smoke test; defaults to the real Resend send. */
  sendFounding?: FrontWaveSender;
  /** Injected by the smoke test; defaults to the real Resend send. */
  sendFriendJoined?: FriendJoinedSender;
  /** Injected by the smoke test; defaults to the real Resend send. */
  sendPass?: WelcomeSender;
};

const FORMAT_ERROR = "That address doesn't look right.";

/** Same generator as the unsubscribe token; a separate value, never the same one. */
export function generateShareToken() {
  return generateUnsubscribeToken();
}

/**
 * What a bot, a too-fast fill or a rate-limited caller sees: the back of the line, the
 * next planet, and a token that exists nowhere. Indistinguishable in shape from a real
 * ticket; resolves to nothing if followed.
 */
async function plausibleTicket(): Promise<InterestTicket> {
  const proof = await getInterestProof();
  const number = proof.total + 1;
  return {
    number,
    position: proof.count + 1,
    referrals: 0,
    frontWave: false,
    founding: false,
    planet: planetForSignupNumber(number),
    joinedAt: new Date().toISOString(),
    shareToken: generateShareToken(),
  };
}

export async function joinInterestListCore(
  input: InterestListInput,
  ctx: JoinContext
): Promise<InterestListResult> {
  // 1. Honeypot, before parsing: a filled decoy field is a bot, and a bot gets a ticket.
  if (typeof input.website === "string" && input.website.length > 0) {
    return { ok: true, ticket: await plausibleTicket() };
  }

  // 2. Validation — the one path with a visible error.
  const parsed = interestListSchema.safeParse(input);
  if (!parsed.success) return { ok: false, message: FORMAT_ERROR };
  const { elapsedMs, ref } = parsed.data;
  const email = parsed.data.email.trim().toLowerCase();

  // 3. Faster than a person can read the form.
  if (elapsedMs < MIN_FILL_MS) return { ok: true, ticket: await plausibleTicket() };

  // 4. Rate limit. A limiter that cannot count must not fail open into the write, and must
  //    not break a real person's signup either — so any throw is the fake ticket.
  try {
    await consumeBucket("interest.join", ctx.ip, RATE_LIMITS.interestJoin);
  } catch (err) {
    // Past the limit, or a limiter that cannot count. Either way the caller gets the fake
    // ticket — the write must never fail open — but only the first is expected. The
    // response stays indistinguishable from a real join, so this log is the only signal
    // that a real person was dropped.
    if (isRateLimitedError(err)) console.warn("[interest-list] join rate-limited", { ipTag: ipLogTag(ctx.ip) });
    else console.error("[interest-list] limiter failed", err);
    return { ok: true, ticket: await plausibleTicket() };
  }

  const db = await getDb();

  // 5. Who sent them, if anyone.
  const referrer = ref
    ? (
        await db
          .select({
            id: interestListSignups.id,
            email: interestListSignups.email,
            unsubscribeToken: interestListSignups.unsubscribeToken,
            unsubscribedAt: interestListSignups.unsubscribedAt,
            welcomePlanet: interestListSignups.welcomePlanet,
            shareToken: interestListSignups.shareToken,
          })
          .from(interestListSignups)
          .where(eq(interestListSignups.shareToken, ref))
          .limit(1)
      )[0] ?? null
    : null;

  // 6. Read, then write down one of three branches.
  const [existing] = await db
    .select()
    .from(interestListSignups)
    .where(eq(interestListSignups.email, email))
    .limit(1);

  let row = existing;
  let welcome = false;
  /** A fresh row that credited `referrer` — the only event that can complete a front wave. */
  let credited = false;

  if (!existing) {
    // The planet this signup gets: one step further out than the last. Counted before the
    // insert so the number is this row's own ordinal.
    const [before] = await db.select({ n: sql<number>`count(*)::int` }).from(interestListSignups);
    const inserted = await db
      .insert(interestListSignups)
      .values({
        email,
        referrer: ctx.attribution?.referrer ?? null,
        utmSource: ctx.attribution?.utmSource ?? null,
        utmMedium: ctx.attribution?.utmMedium ?? null,
        utmCampaign: ctx.attribution?.utmCampaign ?? null,
        landingPath: ctx.attribution?.landingPath ?? null,
        unsubscribeToken: generateUnsubscribeToken(),
        shareToken: generateShareToken(),
        welcomePlanet: planetForSignupNumber((before?.n ?? 0) + 1),
        // Never yourself: a token whose row owns this address is not a referral.
        referredById: referrer && referrer.email !== email ? referrer.id : null,
      })
      .onConflictDoNothing({ target: interestListSignups.email })
      // Bare, not `.returning({...})`: an explicit selector defeats Drizzle's overload
      // resolution after an `onConflict*` call in this TS version.
      .returning();

    if (inserted[0]) {
      row = inserted[0];
      welcome = true;
      credited = Boolean(row.referredById);
      invalidateInterestProof();
    } else {
      // Lost a race with a concurrent submit of the same address: it exists now.
      [row] = await db
        .select()
        .from(interestListSignups)
        .where(eq(interestListSignups.email, email))
        .limit(1);
    }
  }

  if (row && !welcome) {
    if (row.unsubscribedAt) {
      // Rejoining puts them back in line at their original join time. The planet is
      // theirs — rewriting it would contradict the mail they already have.
      // referred_by_id is untouched: credit is written once, on insert.
      [row] = await db
        .update(interestListSignups)
        .set({
          unsubscribedAt: null,
          followUpSentAt: null,
          shareToken: row.shareToken ?? generateShareToken(),
        })
        .where(eq(interestListSignups.id, row.id))
        .returning();
      welcome = true;
    } else if (!row.shareToken) {
      // A row from before share tokens existed: mint one, send nothing.
      [row] = await db
        .update(interestListSignups)
        .set({ shareToken: generateShareToken() })
        .where(eq(interestListSignups.id, row.id))
        .returning();
    }
  }

  if (!row?.shareToken) {
    // Unreachable: every branch above leaves a row with a token. Fail like a bot would.
    return { ok: true, ticket: await plausibleTicket() };
  }

  // 7. Already on the list: the pass goes to the address's own inbox, never onto the
  //    screen of whoever typed it.
  if (!welcome) {
    await mailPass({ ...row, shareToken: row.shareToken }, ctx);
    return { ok: true, emailed: true };
  }

  // Counted before the welcome, because the welcome states the place in line. But a throw
  // here must not cost the welcome: the row is durable now, and a retry would land on the
  // active branch, which sends nothing. So the welcome goes out without a number, and the
  // error is raised after it.
  let ticket: InterestTicket | null = null;
  let ticketError: unknown = null;
  try {
    ticket = await ticketForRow({
      id: row.id,
      createdAt: row.createdAt,
      welcomePlanet: row.welcomePlanet,
      shareToken: row.shareToken,
    });
  } catch (err) {
    ticketError = err;
  }

  if (welcome) {
    const pageUrl = getWaitlistPageUrl();
    const send = ctx.sendWelcome ?? sendInterestListWelcomeEmail;
    // The real sender only ever logs, so a Resend outage never fails the join.
    await send(
      row.email,
      buildUnsubscribeUrl(row.unsubscribeToken),
      asWelcomePlanet(row.welcomePlanet),
      {
        ticketUrl: buildTicketUrl(pageUrl, row.shareToken),
        shareUrl: buildShareUrl(pageUrl, row.shareToken),
      },
      ticket?.position ?? null
    );
  }
  if (!ticket) throw ticketError;

  if (credited && referrer && !referrer.unsubscribedAt && referrer.shareToken) {
    await notifyReferrer(referrer as typeof referrer & { shareToken: string }, ctx);
  }

  return { ok: true, ticket };
}

/**
 * Every credited referral is news to the referrer, and exactly one email says so:
 *
 *   - the friend that takes them to exactly `FRONT_WAVE_REFERRALS` → the front-wave email;
 *   - exactly `FOUNDING_REFERRALS` → the founding-badge email;
 *   - any other count below `FOUNDING_REFERRALS` → "a friend joined", with the gap to the
 *     next tier;
 *   - past `FOUNDING_REFERRALS` → nothing: there is no tier left to reach.
 *
 * Exactly, not at-least, and counted over still-waiting friends like the line itself. It
 * runs once per credited insert, so no column is needed to dedupe it. A friend who leaves
 * and a new one who joins can cross a line twice — rare, and a second "you're in" is
 * harmless.
 *
 * Never throws: the join it rides on has already succeeded.
 */
async function notifyReferrer(
  referrer: {
    id: string;
    email: string;
    unsubscribeToken: string;
    welcomePlanet: string | null;
    shareToken: string;
  },
  ctx: JoinContext
) {
  try {
    const db = await getDb();
    const [count] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(interestListSignups)
      .where(
        and(eq(interestListSignups.referredById, referrer.id), isNull(interestListSignups.unsubscribedAt))
      );
    const n = count?.n ?? 0;
    if (n < 1 || n > FOUNDING_REFERRALS) return;
    const pageUrl = getWaitlistPageUrl();
    const args = [
      referrer.email,
      buildUnsubscribeUrl(referrer.unsubscribeToken),
      asWelcomePlanet(referrer.welcomePlanet),
      {
        ticketUrl: buildTicketUrl(pageUrl, referrer.shareToken),
        shareUrl: buildShareUrl(pageUrl, referrer.shareToken),
      },
    ] as const;
    if (n === FRONT_WAVE_REFERRALS) await (ctx.sendFrontWave ?? sendFrontWaveEmail)(...args);
    else if (n === FOUNDING_REFERRALS) await (ctx.sendFounding ?? sendFoundingEmail)(...args);
    else await (ctx.sendFriendJoined ?? sendFriendJoinedEmail)(...args, n);
  } catch (err) {
    console.error("[interest-list] referrer notice failed", err);
  }
}

/**
 * Mails a waiting row its pass, at most `RATE_LIMITS.interestPassEmail` times per window
 * per address. The bucket key is a hash, so the limiter table never holds an address.
 * Never throws: every caller answers the same thing whether or not this sent.
 */
async function mailPass(
  row: {
    id: string;
    email: string;
    createdAt: Date;
    unsubscribeToken: string;
    welcomePlanet: string | null;
    shareToken: string;
  },
  ctx: Pick<JoinContext, "sendPass">
) {
  try {
    const key = createHash("sha256").update(row.email).digest("base64url");
    await consumeBucket("interest.pass", key, RATE_LIMITS.interestPassEmail);
  } catch (err) {
    if (!isRateLimitedError(err)) console.error("[interest-list] pass limiter failed", err);
    return;
  }
  try {
    const ticket = await ticketForRow(row).catch(() => null);
    const pageUrl = getWaitlistPageUrl();
    await (ctx.sendPass ?? sendPassEmail)(
      row.email,
      buildUnsubscribeUrl(row.unsubscribeToken),
      asWelcomePlanet(row.welcomePlanet),
      {
        ticketUrl: buildTicketUrl(pageUrl, row.shareToken),
        shareUrl: buildShareUrl(pageUrl, row.shareToken),
      },
      ticket?.position ?? null
    );
  } catch (err) {
    console.error("[interest-list] pass email failed", err);
  }
}

const passEmailSchema = interestListSchema.pick({ email: true, website: true, elapsedMs: true });

/**
 * "Already on the list? Email me my pass." Answers `ok` for every well-formed address —
 * on the list or not, bot or not, limited or not — so the form reveals nothing; only the
 * address's own inbox learns whether it was there. It never adds anyone to the list.
 */
export async function emailPassCore(
  input: { email: string; website: string; elapsedMs: number },
  ctx: Pick<JoinContext, "ip" | "sendPass">
): Promise<PassEmailResult> {
  if (typeof input.website === "string" && input.website.length > 0) return { ok: true };
  const parsed = passEmailSchema.safeParse(input);
  if (!parsed.success) return { ok: false, message: FORMAT_ERROR };
  if (parsed.data.elapsedMs < MIN_FILL_MS) return { ok: true };
  try {
    // The join's bucket: one budget per IP for everything that looks an address up.
    await consumeBucket("interest.join", ctx.ip, RATE_LIMITS.interestJoin);
  } catch (err) {
    if (isRateLimitedError(err)) console.warn("[interest-list] pass request rate-limited", { ipTag: ipLogTag(ctx.ip) });
    else console.error("[interest-list] limiter failed", err);
    return { ok: true };
  }

  const db = await getDb();
  const [row] = await db
    .select()
    .from(interestListSignups)
    .where(
      and(
        eq(interestListSignups.email, parsed.data.email.trim().toLowerCase()),
        isNull(interestListSignups.unsubscribedAt)
      )
    )
    .limit(1);
  if (row?.shareToken) await mailPass({ ...row, shareToken: row.shareToken }, ctx);
  return { ok: true };
}
