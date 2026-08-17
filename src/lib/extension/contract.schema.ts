/**
 * Runtime validation for the extension API.
 *
 * Deliberate divergence from the rest of the codebase: server actions here are
 * not zod-validated, which is defensible because their only callers are the
 * app's own type-checked components. These endpoints are reachable over HTTP by
 * anything holding a session, so every field is validated at the boundary.
 * Please don't "clean this up" for consistency.
 *
 * Server-only — the extension imports `./contract.ts` (types) and never this.
 * Each schema's inferred type is asserted against the hand-written contract
 * type, so the two cannot drift silently.
 */

import { z } from "zod";
import type {
  ContactSearchResponse,
  FollowUpRequest,
  LogInteractionRequest,
  PageContext,
  ResolveRequest,
  SaveContactRequest,
  StartersRequest,
} from "./contract";

/** Hard ceiling on a request body, checked before and after reading. */
export const MAX_BODY_BYTES = 64_000;
/** Page text is truncated to this before it ever reaches a prompt. */
export const MAX_RAW_TEXT_CHARS = 8_000;

/** Compile-time proof that a schema matches its contract type in both directions. */
type Exact<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never;

const httpsUrl = z
  .string()
  .trim()
  .max(2_048)
  .refine((value) => {
    try {
      // Only https — these URLs are stored, and photoUrl is later fetched
      // server-side by the avatar pipeline, so anything else is an SSRF vector.
      return new URL(value).protocol === "https:";
    } catch {
      return false;
    }
  }, "must be an https URL");

const shortText = z.string().trim().max(500);
const freeText = z.string().max(20_000);
const isoDate = z.string().trim().max(40);

const extractedField = z
  .object({
    value: z.string().max(2_048),
    source: z.string().max(64),
    confidence: z.enum(["high", "medium", "low"]),
  })
  .nullable();

const pageIdentitySchema = z.object({
  name: extractedField,
  headline: extractedField,
  title: extractedField,
  company: extractedField,
  location: extractedField,
  school: extractedField,
  email: extractedField,
  handle: extractedField,
  profileUrl: extractedField,
  photoUrl: extractedField,
});

export const pageContextSchema = z.object({
  schemaVersion: z.literal(1),
  site: z.enum(["linkedin", "x", "gmail", "generic"]),
  adapterVersion: z.string().max(32),
  kind: z.enum(["person", "thread", "list", "company", "post", "unknown"]),
  url: z.string().trim().max(2_048),
  sourceUrl: z.string().trim().max(2_048),
  capturedAt: isoDate,
  identity: pageIdentitySchema,
  candidates: z
    .array(
      z.object({
        name: z.string().max(200),
        profileUrl: z.string().max(2_048).optional(),
        subtitle: z.string().max(300).optional(),
      })
    )
    .max(10)
    .optional(),
  text: z.object({
    // The outer bound catches abuse; the transform handles the normal case of a
    // big-but-legitimate profile. Truncate rather than reject — a 200KB DOM
    // dump should still produce starters.
    blob: z
      .string()
      .max(200_000)
      .transform((value) => value.slice(0, MAX_RAW_TEXT_CHARS)),
    truncated: z.boolean(),
    charCount: z.number().int().nonnegative(),
    fromSelection: z.boolean(),
  }),
  warnings: z.array(z.string().max(64)).max(20),
});

export const resolveRequestSchema = z.object({
  page: pageContextSchema,
});

export const startersRequestSchema = z.object({
  contactId: z.uuid().nullish(),
  page: pageContextSchema,
  limit: z.number().int().min(1).max(5).optional(),
  channel: z.enum(["linkedin", "email"]).optional(),
});

const followUpSchema = z.union([
  z.object({ at: isoDate.nullable() }),
  z.object({ inDays: z.number().int().min(0).max(3_650) }),
]);

const inlineNoteSchema = z.object({
  rawNotes: freeText,
  interactionType: z.string().trim().max(40).optional(),
  interactionDate: isoDate.optional(),
});

const saveContactFieldsSchema = z.object({
  fullName: z.string().trim().min(1).max(200),
  firstName: z.string().trim().max(100).optional(),
  lastName: z.string().trim().max(100).optional(),
  company: z.string().trim().max(200).optional(),
  title: z.string().trim().max(200).optional(),
  location: z.string().trim().max(200).optional(),
  school: z.string().trim().max(200).optional(),
  email: z.email().max(320).optional(),
  phone: z.string().trim().max(40).optional(),
  linkedinUrl: httpsUrl.optional(),
  xHandle: z.string().trim().max(64).optional(),
  website: httpsUrl.optional(),
  photoUrl: httpsUrl.optional(),
  relationshipScore: z.number().int().min(1).max(5).optional(),
  metContext: z.string().trim().max(40).optional(),
  howMet: z.string().trim().max(500).optional(),
  dateMet: isoDate.optional(),
  notes: freeText.optional(),
  tagNames: z.array(z.string().trim().min(1).max(60)).max(20).optional(),
  keyFacts: z.array(shortText).max(50).optional(),
  sharedInterests: z.array(shortText).max(50).optional(),
});

export const saveContactRequestSchema = z
  .object({
    mode: z.enum(["create", "merge"]),
    contactId: z.uuid().optional(),
    page: pageContextSchema,
    fields: saveContactFieldsSchema,
    note: inlineNoteSchema.optional(),
    followUp: followUpSchema.optional(),
    force: z.boolean().optional(),
  })
  .refine((body) => body.mode !== "merge" || Boolean(body.contactId), {
    message: "contactId is required when mode is 'merge'",
    path: ["contactId"],
  });

export const logInteractionRequestSchema = z.object({
  contactId: z.uuid(),
  rawNotes: freeText.refine((value) => value.trim().length > 0, "must not be empty"),
  interactionType: z.string().trim().max(40).optional(),
  interactionDate: isoDate.optional(),
  followUp: followUpSchema.optional(),
});

export const followUpRequestSchema = z.intersection(
  z.object({
    contactId: z.uuid(),
    reminderId: z.uuid().optional(),
    title: z.string().trim().max(200).optional(),
  }),
  followUpSchema
);

export const contactSearchRequestSchema = z.object({
  q: z.string().trim().min(1).max(200),
  limit: z.coerce.number().int().min(1).max(10).default(10),
});

/* Drift guards. If a schema and its contract type diverge, these stop compiling. */
const _resolve: Exact<z.infer<typeof resolveRequestSchema>, ResolveRequest> = true;
const _page: Exact<z.infer<typeof pageContextSchema>, PageContext> = true;
const _starters: Exact<z.infer<typeof startersRequestSchema>, StartersRequest> = true;
const _save: Exact<z.infer<typeof saveContactRequestSchema>, SaveContactRequest> = true;
const _log: Exact<z.infer<typeof logInteractionRequestSchema>, LogInteractionRequest> = true;
const _followUp: Exact<z.infer<typeof followUpRequestSchema>, FollowUpRequest> = true;
void [_resolve, _page, _starters, _save, _log, _followUp];

export type { ContactSearchResponse };
