/**
 * The Zod shapes for the two new per-person fields the capture parse asks for: typed
 * opportunities, and next steps the discussion implied but nobody stated.
 *
 * Kept OUT of `src/lib/ai.ts` on purpose. That module constructs provider SDK clients at
 * import time-adjacent paths and pulls in `@anthropic-ai/sdk`, `openai` and `@google/genai`;
 * the validators that consume these types (`opportunity-extract.ts`,
 * `implied-next-steps.ts`) are pure and are driven directly by `tsx` smoke scripts with no
 * API key. Importing the shapes from here keeps those scripts free of three vendor SDKs.
 *
 * `ai.ts` imports these into `noteParseSchema` rather than restating them.
 */
import { z } from "zod";

const nullTrimmed = z
  .string()
  .nullish()
  .transform((v) => v?.trim() || null);

const confidence01 = z
  .number()
  .nullish()
  .transform((v) => (v == null || Number.isNaN(v) ? 0.5 : Math.min(1, Math.max(0, v))));

export const parsedOpportunitySchema = z.object({
  /** Free text, repaired by `normalizeOpportunityKind`. Never trusted as written. */
  kind: nullTrimmed,
  label: z
    .string()
    .nullish()
    .transform((v) => (v ?? "").replace(/\s+/g, " ").trim()),
  direction: nullTrimmed,
  /** The deadline in the note's own words, if it named one. Resolved in TypeScript, never by the model. */
  due_phrase: nullTrimmed,
  source_excerpt: z
    .string()
    .nullish()
    .transform((v) => v?.trim() || ""),
  confidence: confidence01,
});

export type ParsedOpportunity = z.infer<typeof parsedOpportunitySchema>;

/**
 * Accepts the OLD bare-string shape alongside the typed one.
 *
 * Not defensiveness for its own sake. `opportunities` was `string[]` until this change, and
 * three things still produce that shape in practice: the two-pass detail prompt when it is
 * running terse, a provider returning a cached completion, and any model that skims the
 * field description. Zod rejects the WHOLE object on one bad member, and this field sits
 * inside `people[]` — so a hard failure here does not lose one opportunity, it loses every
 * person in the response. Coercing a bare string to `kind: "other"` keeps the note.
 */
export const opportunityListSchema = z
  .array(z.union([z.string(), parsedOpportunitySchema]))
  .nullish()
  .transform((v) =>
    (v ?? [])
      .map((o): ParsedOpportunity =>
        typeof o === "string"
          ? {
              kind: null,
              label: o.replace(/\s+/g, " ").trim(),
              direction: null,
              due_phrase: null,
              // No excerpt means no evidence, so `validateOpportunities` will drop it on
              // containment. That is the correct outcome: a legacy bare string carries no
              // proof it was ever said, and this path exists to avoid losing the RESPONSE,
              // not to wave the item through.
              source_excerpt: "",
              confidence: 0.5,
            }
          : o
      )
      .filter((o) => o.label.length > 0)
  );

export const parsedImpliedStepSchema = z.object({
  text: z
    .string()
    .nullish()
    .transform((v) => (v ?? "").replace(/\s+/g, " ").trim()),
  /** One short clause saying what in the notes implies it. Shown instead of a date phrase. */
  rationale: nullTrimmed,
  source_excerpt: z
    .string()
    .nullish()
    .transform((v) => v?.trim() || ""),
  confidence: confidence01,
});

export type ParsedImpliedStep = z.infer<typeof parsedImpliedStepSchema>;

export const impliedStepListSchema = z
  .array(parsedImpliedStepSchema)
  .nullish()
  .transform((v) => (v ?? []).filter((s) => s.text.length > 0));
