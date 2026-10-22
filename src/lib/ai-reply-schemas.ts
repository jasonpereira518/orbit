import { z } from "zod";

/**
 * The JSON shapes `lib/ai.ts` asks models for, read with `parseAiJson(schema, raw)`. They sit in
 * their own module so a test can feed them the replies a model actually gets wrong.
 */

/** `{ "text": string }`, the shape the transcription prompts ask for. */
export const transcriptJsonSchema = z.object({ text: z.string().nullish() });

/** The excerpt re-ask: entries the model got wrong are skipped, not fatal to the rest. */
export const excerptRetrySchema = z.object({
  excerpts: z
    .array(z.unknown())
    .transform((entries) =>
      entries.flatMap((entry) => {
        const parsed = z
          .object({ name: z.string().nullish(), source_excerpt: z.string().nullish() })
          .safeParse(entry);
        return parsed.success ? [parsed.data] : [];
      })
    )
    .optional(),
});

const chatRecommendationJsonSchema = z.object({
  contact_id: z.string().nullish(),
  recruiter_id: z.string().nullish(),
  name: z.string(),
  reason: z.string(),
  suggested_action: z.string(),
  draft_message: z.string().nullable(),
});

/**
 * The non-streaming chat answer. A missing or mistyped `answer` / `recommendations` /
 * `proposed_actions` becomes empty (what the old `?? ""` / `?? []` did for absent ones, now
 * also for wrongly typed ones); a recommendation that is not the documented shape is dropped
 * rather than failing the whole answer.
 */
export const chatAnswerJsonSchema = z.object({
  answer: z.string().catch(""),
  recommendations: z
    .array(z.unknown())
    .catch([])
    .transform((items) =>
      items.flatMap((item) => {
        const parsed = chatRecommendationJsonSchema.safeParse(item);
        return parsed.success ? [parsed.data] : [];
      })
    ),
  proposed_actions: z.array(z.unknown()).catch([]),
});

/** `{ "title": … }`, or a bare `null`; `sanitizeChatTitle` decides whether the title is usable. */
export const chatTitleReplySchema = z.object({ title: z.unknown().optional() }).nullable();

/** `{ "draft": … }`, or a bare `null`; `sanitizeDraft` decides whether the draft is usable. */
export const chatRefineReplySchema = z.object({ draft: z.unknown().optional() }).nullable();

/** A wrongly typed field reads as missing: an empty body is already the "empty draft" error. */
export const recruiterDraftReplySchema = z.object({
  subject: z.string().optional().catch(undefined),
  body: z.string().optional().catch(undefined),
});

/** Each score is checked field by field where it is used; this only fixes the outer shape. */
export const rerankReplySchema = z.object({
  scores: z.array(z.object({ id: z.unknown().optional(), relevance: z.unknown().optional() })).optional(),
});

/** Fields are `unknown` on purpose: each goes through its own sanitizer. This fixes the outer shape. */
export const workHistoryAnswerSchema = z.object({ match: z.unknown().optional(), headline: z.unknown().optional(), experiences: z.unknown().optional() });

export const currentRoleAnswerSchema = z.object({
  match: z.unknown().optional(),
  current: z.object({ organization: z.unknown().optional(), title: z.unknown().optional() }).nullish().catch(null),
});

/** Fields are `unknown` on purpose: each goes through `clean` or its own sanitizer. This fixes the outer shape. */
export const personResearchSchema = z.object({
  match: z.unknown().optional(),
  name: z.unknown().optional(),
  headline: z.unknown().optional(),
  current: z.object({ organization: z.unknown().optional(), title: z.unknown().optional() }).nullish().catch(null),
  location: z.unknown().optional(),
  summary: z.unknown().optional(),
  talkingPoints: z.unknown().optional(),
  experiences: z.unknown().optional(),
});

/** The company dossier's reply; every field is cleaned where it is read. */
export const companyResearchSchema = z.object({
  match: z.unknown().optional(),
  website: z.unknown().optional(),
  description: z.unknown().optional(),
  headquarters: z.unknown().optional(),
  founded: z.unknown().optional(),
  size: z.unknown().optional(),
  news: z.unknown().optional(),
  people: z.unknown().optional(),
});

/** The "find people matching a description" reply; each candidate is checked where it is read. */
export const discoveryResearchSchema = z.object({ candidates: z.unknown().optional() });
