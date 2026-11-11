/**
 * What a visitor may send back through someone's card. Everything here is untrusted: it is
 * shape-checked here and cleaned again before storage in `share-back.ts`.
 */
import { z } from "zod";
import { isLinkedInProfileUrl } from "@/lib/contact-input";

/** Trimmed; an empty field reads as not given. */
const optional = (max: number, message: string) =>
  z
    .string()
    .trim()
    .max(max, message)
    .optional()
    .transform((v) => v || undefined);

export const shareBackSchema = z.object({
  slug: z.string().max(64),
  nonce: z
    .string()
    .min(16)
    .max(64)
    .regex(/^[A-Za-z0-9_-]+$/),
  name: z.string().trim().min(1, "Add your name.").max(120, "That name is longer than this field allows."),
  email: optional(320, "That address is too long.").refine(
    (v) => v === undefined || z.email().safeParse(v).success,
    "That address doesn't look right."
  ),
  phone: optional(50, "That number is too long."),
  company: optional(200, "Keep it under 200 characters."),
  title: optional(200, "Keep it under 200 characters."),
  linkedinUrl: optional(500, "That link is too long.").refine(
    (v) => v === undefined || isLinkedInProfileUrl(v),
    "That doesn't look like a LinkedIn profile link."
  ),
  message: optional(500, "Please keep it under 500 characters."),
  /** Honeypot. Hidden from people; a bot that fills it gets a plausible success. */
  website: z.string().max(0).optional(),
  /** Milliseconds between the form rendering and this submission. */
  elapsedMs: z.number().int().nonnegative(),
});
