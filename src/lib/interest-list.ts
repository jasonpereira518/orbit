/**
 * Shape of an Interest list submission and its result, shared by the form, the server
 * action and the smoke tests.
 *
 * Deliberately not inside `src/actions/interest-list.ts`: a "use server" module may only
 * export async functions, so constants and types the form needs have to live somewhere the
 * client can import them from. Client-safe: no `next/*`, no `node:*`, no `@/db`.
 */
import { z } from "zod";
import { planetLabel, type WelcomePlanet } from "@/lib/welcome-planets";

/** A bot fills a form faster than a person can read it. */
export const MIN_FILL_MS = 2500;

/** Below this many signups the proof line shows the next planet only, never the count. */
export const INTEREST_LIST_COUNT_FLOOR = 50;

/** Share and ticket tokens are base64url of 32 bytes = 43 chars; this leaves headroom. */
export const SHARE_TOKEN_MAX = 64;

/** Moons drawn around the planet; past this the count line carries the rest. */
export const MOONS_DRAWN_MAX = 12;

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

/** What a joiner gets back, and what `/interest?me=…` renders. */
export type InterestTicket = {
  /** 1-based ordinal by (created_at, id). */
  number: number;
  planet: WelcomePlanet;
  /** ISO string — this crosses the server-action boundary. */
  joinedAt: string;
  /** People who joined through this ticket's share link. */
  moons: number;
  shareToken: string;
};

export type InterestListResult =
  | { ok: true; ticket: InterestTicket }
  | { ok: false; message: string };

export function buildTicketUrl(appUrl: string, token: string) {
  return `${appUrl}/interest?me=${encodeURIComponent(token)}`;
}

export function buildShareUrl(appUrl: string, token: string) {
  return `${appUrl}/interest?ref=${encodeURIComponent(token)}`;
}

export function buildTicketImageUrl(appUrl: string, token: string) {
  return `${appUrl}/api/interest-list/ticket-image?token=${encodeURIComponent(token)}`;
}

export function formatTicketNumber(number: number) {
  return number.toLocaleString("en-US");
}

/** "Passenger 1,285, bound for Mars." */
export function passengerLine(ticket: Pick<InterestTicket, "number" | "planet">) {
  return `Passenger ${formatTicketNumber(ticket.number)}, bound for ${planetLabel(ticket.planet)}.`;
}

export function moonsLine(moons: number) {
  if (moons === 0) return "No moons yet. Share your link and watch them arrive.";
  if (moons === 1) return "1 person joined through you. That's the moon.";
  return `${formatTicketNumber(moons)} people joined through you. They're the moons.`;
}

/** The prewritten share text; the URL is appended by the share target. */
export function shareText(ticket: Pick<InterestTicket, "number" | "planet">) {
  return `I'm passenger #${formatTicketNumber(ticket.number)} on Orbit's interest list, bound for ${planetLabel(ticket.planet)}. Get your planet:`;
}
