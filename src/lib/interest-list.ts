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
 * Spots each referral moves you up the line. Only friends still on the waitlist count, so
 * an address that bounces (the Resend webhook unsubscribes it) stops counting by itself.
 */
export const SPOTS_PER_REFERRAL = 5;

/** Circles on the referral tracker: the most referrals it draws (the top tier). */
export const TRACKER_SLOTS = 10;

export type ReferralTierId = "joined" | "move-up" | "priority-beta" | "early-access" | "founding";

export type ReferralTier = {
  id: ReferralTierId;
  /** Referrals that unlock it. */
  at: number;
  /** The tier's name on the tracker and the roster. */
  label: string;
  /** What it gets you, in a phrase that finishes "one more friend for …". */
  perk: string;
  /** The tier's line on the tracker's cards. */
  blurb: string;
};

/**
 * The referral perks, lowest first. None of them costs anything to give: each is a place
 * in line, a flag or a badge. `at` values are the referral counts the tracker marks.
 */
export const REFERRAL_TIERS: readonly ReferralTier[] = [
  {
    id: "joined",
    at: 0,
    label: "On the waitlist",
    perk: "a spot on the waitlist",
    blurb: "You've joined the waitlist.",
  },
  {
    id: "move-up",
    at: 1,
    label: "Move up",
    perk: `${SPOTS_PER_REFERRAL} spots up the line`,
    blurb: `Move up ${SPOTS_PER_REFERRAL} spots, and ${SPOTS_PER_REFERRAL} more for every friend after.`,
  },
  {
    id: "priority-beta",
    at: 3,
    label: "Priority beta",
    perk: "priority beta access to features",
    blurb: "Priority beta access to features.",
  },
  {
    id: "early-access",
    at: 5,
    label: "Early access",
    perk: "early access",
    blurb: "Early access.",
  },
  {
    id: "founding",
    at: TRACKER_SLOTS,
    label: "Founding member",
    perk: "the founding member badge",
    blurb: "A founding member badge.",
  },
];

/** Where a referral count sits: the tier it holds, the next one up, and the gap to it. */
export function tierFor(referrals: number): {
  current: ReferralTier;
  next: ReferralTier | null;
  toNext: number;
} {
  const n = Math.max(0, Math.floor(referrals));
  let current = REFERRAL_TIERS[0];
  for (const tier of REFERRAL_TIERS) if (n >= tier.at) current = tier;
  const next = REFERRAL_TIERS.find((tier) => tier.at > n) ?? null;
  return { current, next, toNext: next ? next.at - n : 0 };
}

/** Spots a referral count has earned. Earned, not net: people who join behind you can pass you. */
export function spotsEarned(referrals: number) {
  return Math.max(0, Math.floor(referrals)) * SPOTS_PER_REFERRAL;
}

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
   * Place in line among the people still waiting: join order, less `SPOTS_PER_REFERRAL`
   * for each friend who joined through this ticket. Moves as friends join and as people
   * leave, and can slip when someone behind you refers more people than you have.
   */
  position: number;
  /** Friends who joined through this ticket's link and are still on the waitlist. */
  referrals: number;
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

/** The referral tracker's caption: where you stand and what the next friend gets you. */
export function referralLine(referrals: number) {
  const { next, toNext } = tierFor(referrals);
  if (!next) return `${TRACKER_SLOTS} friends joined. You're a founding member.`;
  if (referrals <= 0) return `Invite a friend to move up ${SPOTS_PER_REFERRAL} spots.`;
  const more = toNext === 1 ? "One more friend" : `${toNext} more friends`;
  return `${referrals} of ${TRACKER_SLOTS} friends joined. ${more} for ${next.perk}.`;
}

/** The prewritten share text; the URL is appended by the share target. */
export const SHARE_TEXT =
  "Just got on the waitlist for something I think you'd actually use. Grab a spot before it opens up:";

/** The native share sheet's title. */
export const SHARE_TITLE = "Early access";
