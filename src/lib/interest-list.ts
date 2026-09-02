/**
 * Shape of an Interest list submission, shared by the form and the server action.
 *
 * Deliberately not inside `src/actions/interest-list.ts`: a "use server" module may only
 * export async functions, so constants and types the form needs have to live somewhere the
 * client can import them from. See `src/lib/contact-message.ts` for the same split.
 */
import { z } from "zod";

/** A bot fills a form faster than a person can read it. */
export const MIN_FILL_MS = 2500;

export const interestListSchema = z.object({
  email: z.email("That address doesn't look right.").max(160),
  /** Honeypot. Hidden from people, irresistible to form-filling bots. */
  website: z.string().max(0),
  /** Milliseconds between the form rendering and this submission. */
  elapsedMs: z.number().int().nonnegative(),
});

export type InterestListInput = z.input<typeof interestListSchema>;

export type InterestListResult =
  | { ok: true }
  | { ok: false; message: string };
