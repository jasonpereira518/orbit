/**
 * Shape of an Interest list submission and its result, shared by the form, the server
 * action and the smoke tests.
 *
 * Deliberately not inside `src/actions/interest-list.ts`: a "use server" module may only
 * export async functions, so constants and types the form needs have to live somewhere the
 * client can import them from. Client-safe: no `next/*`, no `node:*`, no `@/db`.
 */
import { z } from "zod";
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

export const interestListSchema = z.object({
  email: z.email("That address doesn't look right.").max(160),
  /** Honeypot. Hidden from people, irresistible to form-filling bots. */
  website: z.string().max(0),
  /** Milliseconds between the form rendering and this submission. */
  elapsedMs: z.number().int().nonnegative(),
  /** The referrer's share token, from `/interest?ref=…`. */
  ref: z.string().max(SHARE_TOKEN_MAX).optional(),
});

export type InterestListInput = z.input<typeof interestListSchema>;

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
};

export type InterestListResult =
  | { ok: true; ticket: InterestTicket }
  | { ok: false; message: string };

/**
 * `pageUrl` is the waitlist page itself — `https://<waitlist host>/` in production,
 * `…/interest` on the app's own origin — or a bare path for in-page history.
 */
export function buildTicketUrl(pageUrl: string, token: string) {
  return `${pageUrl}?me=${encodeURIComponent(token)}`;
}

export function buildShareUrl(pageUrl: string, token: string) {
  return `${pageUrl}?ref=${encodeURIComponent(token)}`;
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
    return `Invite ${FRONT_WAVE_REFERRALS} friends to skip ahead to the front wave.`;
  }
  return `${referrals} of ${FRONT_WAVE_REFERRALS} friends joined. ${left === 1 ? "One more" : `${left} more`} and you're in the front wave.`;
}

/** The prewritten share text; the URL is appended by the share target. */
export const SHARE_TEXT =
  "Just got on the waitlist for something I think you'd actually use. Grab a spot before it opens up:";

/** The native share sheet's title. */
export const SHARE_TITLE = "Early access";
