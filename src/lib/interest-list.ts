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

/** Kept for callers that still send `elapsedMs`; no minimum wait is enforced on join. */
export const MIN_FILL_MS = 0;

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

/** Operator-added signup from an in-person event (admin console). */
export const SIGNUP_EVENT_LABEL_MAX = 120;

export const adminManualInterestListSchema = z.object({
  email: z.email("That address doesn't look right.").max(160),
  firstName: z.string().trim().min(1, "First name is required.").max(NAME_MAX),
  lastName: z.string().trim().min(1, "Last name is required.").max(NAME_MAX),
  eventLabel: z
    .string()
    .trim()
    .min(2, "Event name is required.")
    .max(SIGNUP_EVENT_LABEL_MAX),
  /** When they signed at the event — used for join order when pasting a spreadsheet. */
  createdAt: z.coerce.date().optional(),
});

export type AdminManualInterestListInput = z.infer<typeof adminManualInterestListSchema>;

/** Cap on one paste so a runaway clipboard cannot mail thousands of welcomes. */
export const ADMIN_EVENT_PASTE_MAX = 100;

export type ParsedEventSignupRow = {
  /** Spreadsheet timestamp, or null when the line had no parseable time. */
  signedAt: Date | null;
  firstName: string;
  lastName: string;
  email: string;
  /** 1-based line number in the paste, for error messages. */
  line: number;
};

/**
 * Spreadsheet paste from an event form: `timestamp \t full name \t email` per line
 * (tabs or commas). Keeps paste order; callers sort by `signedAt` when every row has one.
 */
export function parseEventSignupPaste(text: string): {
  rows: ParsedEventSignupRow[];
  errors: string[];
} {
  const rows: ParsedEventSignupRow[] = [];
  const errors: string[] = [];
  const seen = new Set<string>();
  const lines = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]!.trim();
    if (!raw) continue;
    const line = i + 1;
    const cols = raw.includes("\t")
      ? raw.split("\t").map((c) => c.trim())
      : raw.split(",").map((c) => c.trim());

    // `time | name | email` or `name | email` when someone strips the timestamp column.
    let signedAt: Date | null = null;
    let nameRaw: string;
    let emailRaw: string;
    if (cols.length >= 3) {
      signedAt = parseEventSpreadsheetTime(cols[0]!);
      nameRaw = cols[1]!;
      emailRaw = cols[2]!;
    } else if (cols.length === 2) {
      nameRaw = cols[0]!;
      emailRaw = cols[1]!;
    } else {
      errors.push(`Line ${line}: expected timestamp, name, and email.`);
      continue;
    }

    const emailParsed = z.email().max(160).safeParse(emailRaw.toLowerCase());
    if (!emailParsed.success) {
      errors.push(`Line ${line}: “${emailRaw || "(empty)"}” is not a valid email.`);
      continue;
    }
    const email = emailParsed.data;
    if (seen.has(email)) {
      errors.push(`Line ${line}: ${email} appears more than once in the paste.`);
      continue;
    }
    seen.add(email);

    const nameParts = nameRaw.trim().split(/\s+/).filter(Boolean);
    if (nameParts.length === 0) {
      errors.push(`Line ${line}: missing name.`);
      continue;
    }
    const firstName = nameParts[0]!.slice(0, NAME_MAX);
    const lastName = (nameParts.slice(1).join(" ") || nameParts[0]!).slice(0, NAME_MAX);

    rows.push({ signedAt, firstName, lastName, email, line });
  }

  if (rows.length > ADMIN_EVENT_PASTE_MAX) {
    return {
      rows: [],
      errors: [`Paste at most ${ADMIN_EVENT_PASTE_MAX} people at a time (${rows.length} found).`],
    };
  }

  return { rows, errors };
}

/** `9/9/2026 17:32:18` (US M/D/Y, 24h) as America/New_York wall time → UTC Date. */
export function parseEventSpreadsheetTime(raw: string): Date | null {
  const m = raw
    .trim()
    .match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (!m) return null;
  const month = Number(m[1]);
  const day = Number(m[2]);
  const year = Number(m[3]);
  const hour = Number(m[4]);
  const minute = Number(m[5]);
  const second = Number(m[6] ?? 0);
  if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59 || second > 59) {
    return null;
  }
  // Interpret as Eastern wall clock without a TZ library: format as ISO-like offset guess
  // via Intl. Build a UTC instant that formats back to this clock in America/New_York.
  const guess = Date.UTC(year, month - 1, day, hour, minute, second);
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(guess));
  const get = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((p) => p.type === type)?.value);
  const asNy = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
  const adjusted = new Date(guess - (asNy - guess));
  return Number.isNaN(adjusted.getTime()) ? null : adjusted;
}

/** `ok` for a real save, a repeat and an unknown token alike — see `saveInterestListNameCore`. */
export type InterestNameResult = { ok: true } | { ok: false; message: string };

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
  "I've been testing out Orbit, a new app for keeping track of professional relationships and follow-ups. I'm joining their early access list. Grab a spot before it opens up:";

/** The native share sheet's title. */
export const SHARE_TITLE = "Early access";
