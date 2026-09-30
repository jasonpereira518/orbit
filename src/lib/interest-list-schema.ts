/**
 * The zod schemas for the Interest list's server-side validation. Split from
 * `interest-list.ts` so the waitlist page's client bundle never pulls in zod: import this
 * only from server code (the join core, the admin console's server half, smokes).
 */
import { z } from "zod";
import {
  EMAIL_MAX,
  EMAIL_PATTERN,
  NAME_MAX,
  SHARE_TOKEN_MAX,
  SIGNUP_EVENT_LABEL_MAX,
} from "@/lib/interest-list";

/** The same pattern the form checks with, so client and server never disagree. */
const email = (error: string) => z.email({ pattern: EMAIL_PATTERN, error }).max(EMAIL_MAX);

export const interestListSchema = z.object({
  email: email("That address doesn't look right."),
  /** Honeypot. Hidden from people, irresistible to form-filling bots. */
  website: z.string().max(0),
  /** Milliseconds between the form rendering and this submission. */
  elapsedMs: z.number().int().nonnegative(),
  /** Who sent them: a referral slug (`/waitlist/<slug>`) or, on older links, a share token. */
  ref: z.string().max(SHARE_TOKEN_MAX).optional(),
});

export type InterestListInput = z.input<typeof interestListSchema>;

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

export const adminManualInterestListSchema = z.object({
  email: email("That address doesn't look right."),
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
