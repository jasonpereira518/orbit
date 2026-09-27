/**
 * Shape of an Interest list submission and its result, shared by the form, the server
 * action and the smoke tests.
 *
 * Deliberately not inside `src/actions/interest-list.ts`: a "use server" module may only
 * export async functions, so constants and types the form needs have to live somewhere the
 * client can import them from. Client-safe: no `next/*`, no `node:*`, no `@/db`.
 */
import { z } from "zod";
import { RESERVED_WAITLIST_SLUGS } from "@/lib/waitlist-host";
import type { WelcomePlanet } from "@/lib/welcome-planets";

/** A bot fills a form faster than a person can read it. */
export const MIN_FILL_MS = 2500;

/** Below this many people on the waitlist the proof line shows no count at all. */
export const INTEREST_LIST_COUNT_FLOOR = 50;

/** Share and ticket tokens are base64url of 32 bytes = 43 chars; this leaves headroom. */
export const SHARE_TOKEN_MAX = 64;

/**
 * Friends who must join through your link to put you in the front wave — the first group
 * let in, ahead of everyone who has not. Only friends still on the waitlist count, so an
 * address that bounces (the Resend webhook unsubscribes it) stops counting by itself.
 */
export const FRONT_WAVE_REFERRALS = 3;

/** Longest referral slug, suffix included. Well inside `SHARE_TOKEN_MAX`, which `?ref=` shares. */
export const SLUG_MAX = 48;

/** The part of a slug taken from the address, leaving room for a `-12` collision suffix. */
const SLUG_BASE_MAX = SLUG_MAX - 6;

/**
 * The referral slug an address asks for: everything before the `@`, lowercased, cut down to
 * what a URL path takes without escaping (`a-z 0-9 . _ -`). Anything else is dropped, not
 * split on, so `Ada.Lovelace+list@x.com` asks for `ada.lovelacelist`. Never empty and never one of the reserved path names — those become `member`.
 *
 * Only a REQUEST. Two people can share a local part (`sam@gmail.com`, `sam@yahoo.com`),
 * so what a row actually gets is `slugWithSuffix(base, n)` for the first free `n`.
 */
export function slugFromEmail(email: string): string {
  const at = email.lastIndexOf("@");
  const local = at >= 0 ? email.slice(0, at) : email;
  const base = local
    .toLowerCase()
    .replace(/[^a-z0-9._-]/g, "")
    .replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, "")
    .slice(0, SLUG_BASE_MAX)
    .replace(/[^a-z0-9]+$/g, "");
  if (!base || (RESERVED_WAITLIST_SLUGS as readonly string[]).includes(base)) return "member";
  return base;
}

/** `base`, then `base-2`, `base-3`, … — the nth claimant of one local part. */
export function slugWithSuffix(base: string, n: number): string {
  return n <= 1 ? base : `${base}-${n}`;
}

export const interestListSchema = z.object({
  email: z.email("That address doesn't look right.").max(160),
  /** Honeypot. Hidden from people, irresistible to form-filling bots. */
  website: z.string().max(0),
  /** Milliseconds between the form rendering and this submission. */
  elapsedMs: z.number().int().nonnegative(),
  /** Who sent them: a referral slug (`/waitlist/<slug>`) or, on older links, a share token. */
  ref: z.string().max(SHARE_TOKEN_MAX).optional(),
});

export type InterestListInput = z.input<typeof interestListSchema>;

/** Longest first or last name kept. Generous; the point is a bound, not a rule about names. */
export const NAME_MAX = 60;

/**
 * Step two of the join: the name that goes on the pass. Sent after the address is already on
 * the list, so it is keyed by the ticket's share token rather than repeating the email.
 */
export const interestNameSchema = z.object({
  shareToken: z.string().min(1).max(SHARE_TOKEN_MAX),
  firstName: z.string().trim().min(1, "Please add your first name.").max(NAME_MAX),
  lastName: z.string().trim().min(1, "Please add your last name.").max(NAME_MAX),
});

export type InterestNameInput = z.input<typeof interestNameSchema>;

/** `ok` for a real save, a repeat and an unknown token alike — see `saveInterestListNameCore`. */
export type InterestNameResult = { ok: true } | { ok: false; message: string };

/** What a joiner gets back, and what the waitlist's `?me=…` renders. */
export type InterestTicket = {
  /** 1-based join ordinal by (created_at, id), over every row ever. Picks the planet. */
  number: number;
  /**
   * Place in line among the people still waiting: the front wave first, then everyone
   * else, each by join order. Moves as friends join and as people leave.
   */
  position: number;
  /** Friends who joined through this ticket's link and are still on the waitlist. */
  referrals: number;
  frontWave: boolean;
  planet: WelcomePlanet;
  /** ISO string — this crosses the server-action boundary. */
  joinedAt: string;
  shareToken: string;
  /**
   * The public half of the share link: `/waitlist/<slug>`, the address's local part. Unlike
   * `shareToken` it opens nothing — it can only credit a referral — so it is what gets
   * pasted into public places.
   */
  referralSlug: string;
};

export type InterestListResult =
  | {
      ok: true;
      ticket: InterestTicket;
      /**
       * The address was already on the list before this submit. The form then skips the name
       * step and just shows where they stand. A bot's or rate-limited caller's stand-in ticket
       * is never `returning`, so it looks like a fresh join.
       */
      returning: boolean;
    }
  | { ok: false; message: string };

/**
 * `pageUrl` is the waitlist page itself — `https://<waitlist host>/` in production,
 * `…/interest` on the app's own origin — or a bare path for in-page history.
 */
export function buildTicketUrl(pageUrl: string, token: string) {
  return `${pageUrl}?me=${encodeURIComponent(token)}`;
}

/**
 * The link a person shares: `<origin>/waitlist/<slug>`. A row that has no slug yet (the
 * ticket read that would mint one failed) still gets a working `?ref=` link.
 */
export function buildShareUrl(
  pageUrl: string,
  link: { referralSlug?: string | null; shareToken: string }
) {
  if (!link.referralSlug) return `${pageUrl}?ref=${encodeURIComponent(link.shareToken)}`;
  // `pageUrl` is the page itself — `https://host/` or `https://app/interest` — and the
  // referral path hangs off the origin either way.
  const origin = pageUrl.replace(/\/(?:interest)?\/?$/, "");
  return `${origin}/waitlist/${encodeURIComponent(link.referralSlug)}`;
}

export function buildTicketImageUrl(origin: string, token: string) {
  return `${origin}/api/interest-list/ticket-image?token=${encodeURIComponent(token)}`;
}

export function formatTicketNumber(number: number) {
  return number.toLocaleString("en-US");
}

/** "You're #1,285 on the waitlist." */
export function positionLine(ticket: Pick<InterestTicket, "position">) {
  return `You're #${formatTicketNumber(ticket.position)} on the waitlist.`;
}

/** The front-wave meter's caption. */
export function frontWaveLine(referrals: number) {
  if (referrals >= FRONT_WAVE_REFERRALS) return "You're in the front wave.";
  const left = FRONT_WAVE_REFERRALS - referrals;
  if (referrals === 0) {
    return "Want Orbit sooner?";
  }
  return `${referrals} of ${FRONT_WAVE_REFERRALS} friends joined. ${left === 1 ? "One more" : `${left} more`} and you're in the front wave.`;
}

/** The prewritten share text; the URL is appended by the share target. */
export const SHARE_TEXT =
  "I've been testing out Orbit, a new app for keeping track of professional relationships and follow-ups. I'm joining their early access list. Grab a spot before it opens up:";

/** The native share sheet's title. */
export const SHARE_TITLE = "Early access";
