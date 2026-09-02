import Anthropic from "@anthropic-ai/sdk";
import { GoogleGenAI } from "@google/genai";
import OpenAI from "openai";
import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { userSettings } from "@/db/schema";
import { decryptOrNull } from "@/lib/crypto";
import { z } from "zod";
import {
  withUsage,
  tokensFromGemini,
  tokensFromOpenAi,
  tokensFromAnthropic,
  type TokenCounts,
} from "@/lib/usage-events";
import { aiProviderErrorMessage } from "@/lib/errors";
import {
  AI_PROVIDERS,
  resolveAiModel,
  resolveAiProvider,
  type AiProvider,
  type EmbeddingBackend,
} from "@/lib/ai-providers";

export type { AiProvider, EmbeddingBackend };
export {
  AI_PROVIDERS,
  DEFAULT_MODELS,
  PROVIDER_MODELS,
  resolveAiModel,
  resolveAiProvider,
} from "@/lib/ai-providers";

/** AI often omits unknown fields; accept missing/null. */
const nullStr = z
  .string()
  .nullish()
  .transform((v) => (v == null || v === "" ? null : v));
const nullNum = z
  .number()
  .nullish()
  .transform((v) => (v == null || Number.isNaN(v) ? null : v));
const nullScore = z
  .number()
  .min(1)
  .max(5)
  .nullish()
  .transform((v) => (v == null || Number.isNaN(v) ? null : v));
const nullConfidence = z
  .number()
  .min(0)
  .max(1)
  .nullish()
  .transform((v) => (v == null || Number.isNaN(v) ? null : v));
const strList = z
  .array(z.string())
  .nullish()
  .transform((v) => v ?? []);

export const noteParseSchema = z.object({
  name: nullStr,
  company: nullStr,
  role: nullStr,
  location: nullStr,
  email: nullStr,
  linkedin_url: nullStr,
  met_at: nullStr,
  topics: strList,
  action_items: strList,
  follow_up_recommendation: nullStr,
  follow_up_days: nullNum,
  relationship_score_suggestion: nullScore,
  tags: strList,
  summary: nullStr,
  key_facts: strList,
  opportunities: strList,
  shared_interests: strList,
  suggested_next_message: nullStr,
  confidence: nullConfidence,
  /** ISO date (YYYY-MM-DD) when the notes imply a past event/meeting. */
  interaction_date: nullStr,
  /** Field names (matching this object's keys) the model was unsure about. */
  low_confidence_fields: strList,
});

export type ParsedNote = z.infer<typeof noteParseSchema>;

/** Group/event context that applies to more than one person in a note dump. */
export const sharedNoteContextSchema = z.object({
  text: z.string(),
  met_at: nullStr.optional(),
  topics: strList,
  /** Names of people this shared note applies to (must match people[].name). */
  person_names: strList,
});

export type SharedNoteContext = z.infer<typeof sharedNoteContextSchema>;

export const multiPersonNoteParseSchema = z.object({
  shared_notes: z
    .array(sharedNoteContextSchema)
    .nullable()
    .optional()
    .transform((v) => v ?? []),
  interaction_date: nullStr.optional(),
  people: z.array(
    noteParseSchema.extend({
      // Models sometimes skip this on later people in long dumps.
      source_excerpt: z
        .string()
        .nullish()
        .transform((v) => v?.trim() || ""),
    }),
  ),
});

export type ParsedMultiPersonNotes = z.infer<typeof multiPersonNoteParseSchema>;
export type ParsedPersonNote = ParsedMultiPersonNotes["people"][number];

/** Pass A: identify people + shared context without full field extraction. */
const personIdentitySchema = z.object({
  name: z.string().min(1),
  email: nullStr.optional(),
  company: nullStr.optional(),
  role: nullStr.optional(),
});

const multiPersonIdentitySchema = z.object({
  shared_notes: z
    .array(sharedNoteContextSchema)
    .nullable()
    .optional()
    .transform((v) => v ?? []),
  interaction_date: nullStr.optional(),
  met_at: nullStr.optional(),
  people: z.array(personIdentitySchema),
});

const personDetailBatchSchema = z.object({
  people: z.array(
    noteParseSchema.extend({
      source_excerpt: z
        .string()
        .nullish()
        .transform((v) => v?.trim() || ""),
    }),
  ),
});

export type CaptureParseHints = {
  eventDate?: string | null;
  seedPeople?: Array<{ name?: string | null; email?: string | null }>;
  interactionType?: string | null;
};

const TWO_PASS_CHAR_THRESHOLD = 2500;
const DETAIL_BATCH_SIZE = 4;
const CAPTURE_MAX_OUTPUT_TOKENS = 8192;

const GEMINI_EMBEDDING_MODEL = "gemini-embedding-001";
const OPENAI_EMBEDDING_MODEL = "text-embedding-3-small";

type ProviderKeySettings = {
  geminiApiKeyEncrypted?: string | null;
  openaiApiKeyEncrypted?: string | null;
  anthropicApiKeyEncrypted?: string | null;
};

async function loadSettings(userId: string) {
  const db = await getDb();
  return db.query.userSettings.findFirst({
    where: eq(userSettings.userId, userId),
  });
}

/** Local-dev env fallback only. On Vercel, every user must bring their own key. */
function allowEnvProviderKeys() {
  return !process.env.VERCEL;
}

function getEnvProviderKey(provider: AiProvider): string | null {
  if (!allowEnvProviderKeys()) return null;
  if (provider === "gemini") return process.env.GEMINI_API_KEY || null;
  if (provider === "openai") return process.env.OPENAI_API_KEY || null;
  return process.env.ANTHROPIC_API_KEY || null;
}

function hasPersonalProviderKey(
  provider: AiProvider,
  settings?: ProviderKeySettings | null,
) {
  if (provider === "gemini") return Boolean(settings?.geminiApiKeyEncrypted);
  if (provider === "openai") return Boolean(settings?.openaiApiKeyEncrypted);
  return Boolean(settings?.anthropicApiKeyEncrypted);
}

/**
 * Whether a key EXISTS for this provider, without decrypting it.
 *
 * The notifications panel asks this every 120 seconds to decide whether to show the
 * "add your API key" alert. `getProviderApiKey` would answer the same question, but it
 * runs `decryptOrNull` — pulling a live secret into memory on a polling path, purely to
 * test presence. Presence is all the alert needs.
 *
 * The difference is one edge case: a key that is stored but no longer decryptable (a
 * rotated `ENCRYPTION_KEY`) reads as present here and as absent to `getProviderApiKey`.
 * `getAiCapability` deliberately keeps the stricter, decrypting check — the extension
 * degrades to heuristics off it and must not be told a key works when it does not. The
 * alert accepts the weaker check because that failure mode is an ops incident that breaks
 * every account at once and is loud on its own, not something one user can act on.
 */
export function hasAiKeyFor(
  provider: AiProvider,
  settings?: ProviderKeySettings | null,
): boolean {
  return (
    hasPersonalProviderKey(provider, settings) ||
    Boolean(getEnvProviderKey(provider))
  );
}

export function getProviderApiKey(
  provider: AiProvider,
  settings?: ProviderKeySettings | null,
): string | null {
  const personal =
    provider === "gemini"
      ? decryptOrNull(settings?.geminiApiKeyEncrypted)
      : provider === "openai"
        ? decryptOrNull(settings?.openaiApiKeyEncrypted)
        : decryptOrNull(settings?.anthropicApiKeyEncrypted);

  if (personal) return personal;
  return getEnvProviderKey(provider);
}

export function usingEnvKey(
  provider: AiProvider,
  settings?: ProviderKeySettings | null,
) {
  if (hasPersonalProviderKey(provider, settings)) return false;
  return Boolean(getEnvProviderKey(provider));
}

export async function getAiConfig(userId: string) {
  const settings = await loadSettings(userId);
  const provider = resolveAiProvider(settings?.aiProvider);
  const model = resolveAiModel(provider, settings?.aiModel);
  const apiKey = getProviderApiKey(provider, settings);

  if (!apiKey) {
    const meta = AI_PROVIDERS.find((p) => p.id === provider)!;
    throw new Error(
      `No ${meta.label} API key configured. Add your own key in Settings.`,
    );
  }

  // Whose key pays. On Vercel `getEnvProviderKey` always returns null, so this is "user"
  // in production by construction; "orbit" only happens in local development.
  const keyOwner: "user" | "orbit" = usingEnvKey(provider, settings)
    ? "orbit"
    : "user";

  return { provider, model, apiKey, settings, keyOwner };
}

/**
 * Whether this user can make AI calls at all, without throwing.
 *
 * `getAiConfig` throws when no key is configured, which is the right shape for
 * call sites that need the key but wrong for ones that need to *decide* — the
 * extension has to degrade to heuristics rather than surface an error, since
 * having no key is a normal state (env keys are ignored on Vercel).
 */
export async function getAiCapability(userId: string): Promise<{
  hasKey: boolean;
  provider: AiProvider;
}> {
  const settings = await loadSettings(userId);
  const provider = resolveAiProvider(settings?.aiProvider);
  return { hasKey: Boolean(getProviderApiKey(provider, settings)), provider };
}

export async function userHasAiKey(userId: string): Promise<boolean> {
  return (await getAiCapability(userId)).hasKey;
}

/** Resolve which embedding API to use for semantic search. */
export async function resolveEmbeddingBackend(userId: string): Promise<{
  backend: EmbeddingBackend;
  apiKey: string;
  keyOwner: "user" | "orbit";
}> {
  const settings = await loadSettings(userId);
  const provider = resolveAiProvider(settings?.aiProvider);
  // Whose key pays, resolved per backend since the fallback chain below can land on a
  // different provider than the user's configured one.
  const owner = (p: AiProvider): "user" | "orbit" =>
    usingEnvKey(p, settings) ? "orbit" : "user";

  if (provider === "openai") {
    const apiKey = getProviderApiKey("openai", settings);
    if (!apiKey) {
      throw new Error(
        "No OpenAI API key configured for embeddings. Add your own key in Settings.",
      );
    }
    return { backend: "openai", apiKey, keyOwner: owner("openai") };
  }

  if (provider === "gemini") {
    const apiKey = getProviderApiKey("gemini", settings);
    if (!apiKey) {
      throw new Error(
        "No Gemini API key configured for embeddings. Add your own key in Settings.",
      );
    }
    return { backend: "gemini", apiKey, keyOwner: owner("gemini") };
  }

  // Anthropic has no embeddings API — prefer OpenAI, then Gemini.
  const openaiKey = getProviderApiKey("openai", settings);
  if (openaiKey) {
    return { backend: "openai", apiKey: openaiKey, keyOwner: owner("openai") };
  }

  const geminiKey = getProviderApiKey("gemini", settings);
  if (geminiKey) {
    return { backend: "gemini", apiKey: geminiKey, keyOwner: owner("gemini") };
  }

  throw new Error(
    "Anthropic has no embeddings API. Add an OpenAI or Gemini key in Settings for search embeddings.",
  );
}

function extractJsonText(raw: string) {
  const trimmed = raw.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  return fenced?.[1]?.trim() || trimmed;
}

function findJsonEnd(text: string, start: number) {
  const open = text[start];
  const close = open === "{" ? "}" : "]";
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (ch === "\\") {
        escaped = true;
        continue;
      }
      if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) return i;
    }
  }

  return -1;
}

/**
 * Close dangling strings / braces when a model truncates mid-JSON
 * (common with short max-output limits).
 */
function repairTruncatedJson(text: string): string | null {
  const start = text.search(/[\[{]/);
  if (start === -1) return null;

  let slice = text.slice(start);
  let inString = false;
  let escaped = false;
  const stack: string[] = [];

  for (let i = 0; i < slice.length; i++) {
    const ch = slice[i]!;
    if (inString) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (ch === "\\") {
        escaped = true;
        continue;
      }
      if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === "{") stack.push("}");
    else if (ch === "[") stack.push("]");
    else if (ch === "}" || ch === "]") {
      if (stack.length > 0 && stack[stack.length - 1] === ch) stack.pop();
    }
  }

  if (escaped) slice = slice.slice(0, -1);
  if (inString) slice += '"';
  while (stack.length > 0) slice += stack.pop();

  try {
    JSON.parse(slice);
    return slice;
  } catch {
    return null;
  }
}

export function parseAiJson<T = unknown>(raw: string): T {
  const text = extractJsonText(raw);
  try {
    return JSON.parse(text) as T;
  } catch {
    const start = text.search(/[\[{]/);
    if (start === -1) {
      throw new Error(`Failed to parse AI JSON: ${text.slice(0, 200)}`);
    }
    const end = findJsonEnd(text, start);
    if (end !== -1) {
      try {
        return JSON.parse(text.slice(start, end + 1)) as T;
      } catch {
        // fall through to repair
      }
    }
    const repaired = repairTruncatedJson(text);
    if (repaired) {
      return JSON.parse(repaired) as T;
    }
    throw new Error(`Failed to parse AI JSON: ${text.slice(0, 200)}`);
  }
}

function normalizeJsonResponse(raw: string) {
  return JSON.stringify(parseAiJson(raw));
}

export type MultimodalPart =
  | { type: "text"; text: string }
  | { type: "image"; mimeType: string; base64: string }
  | { type: "audio"; mimeType: string; base64: string };

export async function completeJson(
  userId: string,
  input: {
    system: string;
    user: string;
    temperature?: number;
    maxOutputTokens?: number;
    /** Call-site label for usage telemetry, e.g. "capture.parse". */
    operation?: string;
  },
): Promise<string> {
  const { provider, model, apiKey, keyOwner } = await getAiConfig(userId);
  const temperature = input.temperature ?? 0.2;
  const maxOutputTokens = input.maxOutputTokens ?? 4096;
  const system = `${input.system}\n\nRespond with valid JSON only. No markdown fences.`;

  return withUsage(
    {
      userId,
      operation: input.operation ?? "completeJson",
      provider,
      model,
      kind: "completion",
      keyOwner,
    },
    async (report) => {
      try {
        if (provider === "gemini") {
          const client = new GoogleGenAI({ apiKey });
          const response = await client.models.generateContent({
            model,
            contents: input.user,
            config: {
              temperature,
              maxOutputTokens,
              responseMimeType: "application/json",
              systemInstruction: system,
            },
          });
          report(tokensFromGemini(response));
          const content = response.text;
          if (!content) throw new Error("Empty AI response");
          return normalizeJsonResponse(content);
        }

        if (provider === "openai") {
          const client = new OpenAI({ apiKey });
          const response = await client.chat.completions.create({
            model,
            temperature,
            max_tokens: maxOutputTokens,
            response_format: { type: "json_object" },
            messages: [
              { role: "system", content: system },
              { role: "user", content: input.user },
            ],
          });
          report(tokensFromOpenAi(response));
          const content = response.choices[0]?.message?.content;
          if (!content) throw new Error("Empty AI response");
          return normalizeJsonResponse(content);
        }

        const client = new Anthropic({ apiKey });
        const response = await client.messages.create({
          model,
          max_tokens: maxOutputTokens,
          temperature,
          system,
          messages: [{ role: "user", content: input.user }],
        });
        report(tokensFromAnthropic(response));
        const block = response.content.find((b) => b.type === "text");
        if (!block || block.type !== "text" || !block.text) {
          throw new Error("Empty AI response");
        }
        return normalizeJsonResponse(block.text);
      } catch (err) {
        if (err instanceof Error && err.message === "Empty AI response")
          throw err;
        if (
          err instanceof Error &&
          err.message.startsWith("Failed to parse AI JSON")
        ) {
          throw new Error("AI returned an incomplete response. Try again.");
        }
        const label =
          provider === "gemini"
            ? "Gemini"
            : provider === "openai"
              ? "OpenAI"
              : "Anthropic";
        throw new Error(aiProviderErrorMessage(err, label));
      }
    },
  );
}

/** Multimodal JSON completion for vision OCR / image+text prompts. */
export async function completeMultimodalJson(
  userId: string,
  input: MultimodalInput,
): Promise<string> {
  const cfg = await getAiConfig(userId);
  return withUsage(
    {
      userId,
      operation: input.operation ?? "completeMultimodalJson",
      provider: cfg.provider,
      model: cfg.model,
      kind: "multimodal",
      keyOwner: cfg.keyOwner,
    },
    (report) => completeMultimodalJsonInner(cfg, input, report),
  );
}

type MultimodalInput = {
  system: string;
  parts: MultimodalPart[];
  temperature?: number;
  maxOutputTokens?: number;
  /** Call-site label for usage telemetry. */
  operation?: string;
};

/** Body split out so `completeMultimodalJson` stays a thin instrumented wrapper. */
async function completeMultimodalJsonInner(
  cfg: Awaited<ReturnType<typeof getAiConfig>>,
  input: MultimodalInput,
  report: (tokens: TokenCounts) => void,
): Promise<string> {
  const { provider, model, apiKey } = cfg;
  const temperature = input.temperature ?? 0.2;
  const maxOutputTokens = input.maxOutputTokens ?? 4096;
  const system = `${input.system}\n\nRespond with valid JSON only. No markdown fences.`;
  const textParts = input.parts.filter((p) => p.type === "text") as Array<{
    type: "text";
    text: string;
  }>;
  const mediaParts = input.parts.filter((p) => p.type !== "text");

  try {
    if (provider === "gemini") {
      const client = new GoogleGenAI({ apiKey });
      const contents = [
        ...textParts.map((p) => ({ text: p.text })),
        ...mediaParts.map((p) => ({
          inlineData: {
            mimeType: p.mimeType,
            data: p.base64,
          },
        })),
      ];
      const response = await client.models.generateContent({
        model,
        contents: [{ role: "user", parts: contents }],
        config: {
          temperature,
          maxOutputTokens,
          responseMimeType: "application/json",
          systemInstruction: system,
        },
      });
      report(tokensFromGemini(response));
      const content = response.text;
      if (!content) throw new Error("Empty AI response");
      return normalizeJsonResponse(content);
    }

    if (provider === "openai") {
      const client = new OpenAI({ apiKey });
      const content: OpenAI.Chat.ChatCompletionContentPart[] = [
        ...textParts.map((p): OpenAI.Chat.ChatCompletionContentPart => ({
          type: "text",
          text: p.text,
        })),
        ...mediaParts.map((p) => {
          if (p.type === "image") {
            return {
              type: "image_url" as const,
              image_url: {
                url: `data:${p.mimeType};base64,${p.base64}`,
              },
            };
          }
          // OpenAI chat completions don't accept arbitrary audio here — caller
          // should transcribe first. Treat as a text note if somehow passed.
          return {
            type: "text" as const,
            text: `[Audio attachment: ${p.mimeType}]`,
          };
        }),
      ];
      const response = await client.chat.completions.create({
        model,
        temperature,
        max_tokens: maxOutputTokens,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: system },
          { role: "user", content },
        ],
      });
      report(tokensFromOpenAi(response));
      const out = response.choices[0]?.message?.content;
      if (!out) throw new Error("Empty AI response");
      return normalizeJsonResponse(out);
    }

    const client = new Anthropic({ apiKey });
    type AnthropicContent = Exclude<
      Anthropic.MessageCreateParams["messages"][0]["content"],
      string
    >;
    const content: AnthropicContent = [];
    for (const p of textParts) {
      content.push({ type: "text", text: p.text });
    }
    for (const p of mediaParts) {
      if (p.type === "image") {
        const mediaType = (
          ["image/jpeg", "image/png", "image/gif", "image/webp"].includes(
            p.mimeType,
          )
            ? p.mimeType
            : "image/jpeg"
        ) as "image/jpeg" | "image/png" | "image/gif" | "image/webp";
        content.push({
          type: "image",
          source: {
            type: "base64",
            media_type: mediaType,
            data: p.base64,
          },
        });
      } else {
        content.push({
          type: "text",
          text: `[Audio attachment: ${p.mimeType} — transcribe separately]`,
        });
      }
    }
    const response = await client.messages.create({
      model,
      max_tokens: maxOutputTokens,
      temperature,
      system,
      messages: [{ role: "user", content }],
    });
    report(tokensFromAnthropic(response));
    const block = response.content.find((b) => b.type === "text");
    if (!block || block.type !== "text" || !block.text) {
      throw new Error("Empty AI response");
    }
    return normalizeJsonResponse(block.text);
  } catch (err) {
    if (err instanceof Error && err.message === "Empty AI response") throw err;
    if (
      err instanceof Error &&
      err.message.startsWith("Failed to parse AI JSON")
    ) {
      throw new Error("AI returned an incomplete response. Try again.");
    }
    const label =
      provider === "gemini"
        ? "Gemini"
        : provider === "openai"
          ? "OpenAI"
          : "Anthropic";
    throw new Error(aiProviderErrorMessage(err, label));
  }
}

/** Speech-to-text using OpenAI Whisper, or Gemini audio understanding as fallback. */
export async function transcribeAudioWithAI(
  userId: string,
  input: { mimeType: string; base64: string; filename?: string },
): Promise<string> {
  const settings = await loadSettings(userId);
  const openaiKey = getProviderApiKey("openai", settings);
  if (openaiKey) {
    const client = new OpenAI({ apiKey: openaiKey });
    const bytes = Buffer.from(input.base64, "base64");
    const file = new File(
      [bytes],
      input.filename || guessAudioFilename(input.mimeType),
      { type: input.mimeType || "audio/webm" },
    );
    return withUsage(
      {
        userId,
        operation: "capture.transcribe.audio",
        provider: "openai",
        model: "whisper-1",
        kind: "transcription",
        keyOwner: usingEnvKey("openai", settings) ? "orbit" : "user",
      },
      async () => {
        const result = await client.audio.transcriptions.create({
          file,
          model: "whisper-1",
        });
        // Whisper bills per second of audio and returns no usage object, so this row
        // stores null tokens and counts as volume only. A fabricated zero would be a lie
        // that got summed.
        const text = result.text?.trim();
        if (!text) throw new Error("Empty transcription");
        return text;
      },
    );
  }

  const geminiKey = getProviderApiKey("gemini", settings);
  if (geminiKey) {
    const client = new GoogleGenAI({ apiKey: geminiKey });
    const model = resolveAiModel("gemini", settings?.aiModel);
    return withUsage(
      {
        userId,
        operation: "capture.transcribe.audio",
        provider: "gemini",
        model,
        kind: "transcription",
        keyOwner: usingEnvKey("gemini", settings) ? "orbit" : "user",
      },
      async (report) => {
        const response = await client.models.generateContent({
          model,
          contents: [
            {
              role: "user",
              parts: [
                {
                  text: 'Transcribe this audio verbatim. Return JSON: {"text": string}. If unintelligible, use an empty string.',
                },
                {
                  inlineData: {
                    mimeType: input.mimeType || "audio/webm",
                    data: input.base64,
                  },
                },
              ],
            },
          ],
          config: {
            temperature: 0.1,
            maxOutputTokens: 4096,
            responseMimeType: "application/json",
          },
        });
        report(tokensFromGemini(response));
        const raw = response.text;
        if (!raw) throw new Error("Empty transcription");
        const parsed = parseAiJson<{ text?: string }>(raw);
        const text = parsed.text?.trim();
        if (!text) throw new Error("Empty transcription");
        return text;
      },
    );
  }

  throw new Error(
    "Voice capture needs an OpenAI or Gemini API key in Settings for transcription.",
  );
}

function guessAudioFilename(mimeType: string) {
  if (mimeType.includes("mpeg") || mimeType.includes("mp3")) return "audio.mp3";
  if (mimeType.includes("wav")) return "audio.wav";
  if (mimeType.includes("mp4") || mimeType.includes("m4a")) return "audio.m4a";
  if (mimeType.includes("ogg")) return "audio.ogg";
  return "audio.webm";
}

/** OCR / note transcription from one or more images. */
export async function transcribeImagesWithAI(
  userId: string,
  images: Array<{ mimeType: string; base64: string }>,
): Promise<string> {
  if (!images.length) return "";
  const content = await completeMultimodalJson(userId, {
    operation: "capture.transcribe.images",
    temperature: 0.1,
    maxOutputTokens: 8192,
    system: `You transcribe networking / meeting notes from photos (handwritten, whiteboard, typed screenshots, business cards).
Return strict JSON: { "text": string }
Rules:
- Preserve person names, companies, roles, emails, URLs, and action items exactly when readable.
- Keep a sensible reading order (top-to-bottom, left-to-right, page by page).
- Separate distinct blocks with blank lines.
- Do not invent unreadable content; skip illegible fragments.
- If multiple images, concatenate in order with a blank line between pages.`,
    parts: [
      {
        type: "text",
        text: `Transcribe ${images.length} note image(s) into plain text for contact capture.`,
      },
      ...images.map((img): MultimodalPart => ({
        type: "image",
        mimeType: img.mimeType,
        base64: img.base64,
      })),
    ],
  });
  const parsed = parseAiJson<{ text?: string }>(content);
  return (parsed.text || "").trim();
}

const PERSON_FIELD_SHAPE = `{
  "name": string|null,
  "company": string|null,
  "role": string|null,
  "location": string|null,
  "email": string|null,
  "linkedin_url": string|null,
  "met_at": string|null,
  "topics": string[],
  "action_items": string[],
  "follow_up_recommendation": string|null,
  "follow_up_days": number|null,
  "relationship_score_suggestion": 1-5|null,
  "tags": string[],
  "summary": string|null,
  "key_facts": string[],
  "opportunities": string[],
  "shared_interests": string[],
  "suggested_next_message": string|null,
  "confidence": 0-1|null,
  "interaction_date": string|null,
  "low_confidence_fields": string[],
  "source_excerpt": string
}`;

function hintsPreamble(hints?: CaptureParseHints | null) {
  if (!hints) return "";
  const lines: string[] = [];
  if (hints.eventDate?.trim()) {
    lines.push(`Known event/interaction date (ISO): ${hints.eventDate.trim()}`);
  }
  if (hints.seedPeople?.length) {
    const seeds = hints.seedPeople
      .map((p) => {
        const name = p.name?.trim() || "";
        const email = p.email?.trim() || "";
        if (!name && !email) return null;
        if (name && email) return `${name} <${email}>`;
        return name || email;
      })
      .filter(Boolean);
    if (seeds.length) {
      lines.push(`Likely attendees / seed people:\n- ${seeds.join("\n- ")}`);
    }
  }
  if (!lines.length) return "";
  return `\n\nStructured hints from calendar/email (use when consistent with the notes):\n${lines.join("\n")}`;
}

function normalizeSharedNotes(
  shared: SharedNoteContext[],
  peopleNames: string[],
): SharedNoteContext[] {
  const nameSet = new Set(peopleNames.map((n) => n.trim().toLowerCase()));
  return shared
    .filter((s) => s.text?.trim())
    .map((s) => {
      const rawNames = (s.person_names || [])
        .map((n) => n.trim())
        .filter(Boolean);
      const person_names =
        rawNames.length === 0
          ? peopleNames.map((n) => n.trim())
          : rawNames.filter((n) => nameSet.has(n.toLowerCase()));
      return {
        ...s,
        text: s.text.trim(),
        person_names,
      };
    })
    .filter((s) => s.person_names.length >= 2);
}

async function parseMultiPersonSinglePass(
  userId: string,
  notes: string,
  hints?: CaptureParseHints | null,
): Promise<ParsedMultiPersonNotes> {
  const content = await completeJson(userId, {
    operation: "capture.parse",
    temperature: 0.2,
    maxOutputTokens: CAPTURE_MAX_OUTPUT_TOKENS,
    user: notes.slice(0, 100_000) + hintsPreamble(hints),
    system: `You extract structured contact data from networking notes that may mention many people.
Return strict JSON matching this shape:
{
  "shared_notes": [
    {
      "text": string,
      "met_at": string|null,
      "topics": string[],
      "person_names": string[]
    }
  ],
  "interaction_date": string|null,
  "people": [
    ${PERSON_FIELD_SHAPE}
  ]
}
Rules:
- Create one object per distinct person clearly mentioned in the notes.
- Skip vague groups ("a few engineers") with no identifiable person.
- Extract only information supported by the notes. Use null when unknown. Do not invent people or facts.
- Include every key on every person object. Use null (or [] for arrays) when unknown — never omit keys.
- source_excerpt must be the person-specific slice of the original notes (not the whole dump, and not the shared group text alone).
- Never put person-only facts in shared_notes. Never put the full dump in every source_excerpt.
- low_confidence_fields: list the field names (e.g. "company", "role") where you had to guess or infer rather than read directly from the notes. Use [] when every extracted field is directly supported.
- shared_notes: capture context that applies to MULTIPLE people at once — e.g. "met everyone at AWS Summit afterparty", "group dinner after the panel", "all discussed fundraising". Put the shared text in shared_notes[].text, list the affected people in person_names (exact names matching people[].name; use [] to mean everyone), and set met_at/topics when relevant. Do NOT duplicate that shared text into every source_excerpt.
- If a fact is only about one person, keep it in that person's fields/source_excerpt — not in shared_notes.
- If several people share the same event/place, set each person's met_at (and include it on shared_notes too).
- interaction_date: YYYY-MM-DD when the notes/calendar imply a specific past event date; otherwise null.
- relationship_score_suggestion: 1=barely know, 2=met once, 3=real conversation, 4=strong, 5=mentor/advocate.
- If the notes only cover one person, return a single-item people array and an empty shared_notes array.
- When seed people/hints are provided, include them if they appear in or clearly belong to this meeting, and prefer their emails when matching.`,
  });

  const parsed = multiPersonNoteParseSchema.parse(JSON.parse(content));
  const people = parsed.people.filter((p) => p.name?.trim());
  const shared_notes = normalizeSharedNotes(
    parsed.shared_notes || [],
    people.map((p) => p.name!.trim()),
  );

  const defaultDate =
    parsed.interaction_date || hints?.eventDate?.trim() || null;

  return {
    shared_notes,
    interaction_date: defaultDate,
    people: people.map((p) => ({
      ...p,
      interaction_date: p.interaction_date || defaultDate,
      met_at: p.met_at || null,
    })),
  };
}

async function parseMultiPersonTwoPass(
  userId: string,
  notes: string,
  hints?: CaptureParseHints | null,
): Promise<ParsedMultiPersonNotes> {
  const sliced = notes.slice(0, 100_000);
  const identityRaw = await completeJson(userId, {
    operation: "capture.parse.identify",
    temperature: 0.2,
    maxOutputTokens: 4096,
    user: sliced + hintsPreamble(hints),
    system: `You identify every distinct person in networking notes, plus shared group/event context.
Return strict JSON:
{
  "shared_notes": [
    {
      "text": string,
      "met_at": string|null,
      "topics": string[],
      "person_names": string[]
    }
  ],
  "interaction_date": string|null,
  "met_at": string|null,
  "people": [
    { "name": string, "email": string|null, "company": string|null, "role": string|null }
  ]
}
Rules:
- One object per identifiable person. Skip vague groups with no name.
- Do not invent people. Prefer seed attendees when they clearly belong to this event.
- shared_notes hold ONLY multi-person context (not person-only facts). person_names must match people[].name (or [] for everyone).
- interaction_date: YYYY-MM-DD when known from notes/hints; else null.
- Keep people list complete even for long dumps.`,
  });

  const identity = multiPersonIdentitySchema.parse(JSON.parse(identityRaw));
  const peopleIds = identity.people.filter((p) => p.name?.trim());

  // Merge seed people that weren't found by name/email.
  if (hints?.seedPeople?.length) {
    for (const seed of hints.seedPeople) {
      const seedName = seed.name?.trim();
      const seedEmail = seed.email?.trim()?.toLowerCase();
      if (!seedName && !seedEmail) continue;
      const exists = peopleIds.some((p) => {
        if (
          seedName &&
          p.name.trim().toLowerCase() === seedName.toLowerCase()
        ) {
          return true;
        }
        if (seedEmail && p.email?.trim().toLowerCase() === seedEmail) {
          return true;
        }
        return false;
      });
      if (!exists && seedName) {
        peopleIds.push({
          name: seedName,
          email: seed.email ?? null,
          company: null,
          role: null,
        });
      }
    }
  }

  if (!peopleIds.length) {
    return { shared_notes: [], interaction_date: null, people: [] };
  }

  const shared_notes = normalizeSharedNotes(
    identity.shared_notes || [],
    peopleIds.map((p) => p.name.trim()),
  );
  const defaultDate =
    identity.interaction_date || hints?.eventDate?.trim() || null;
  const sharedMetAt = identity.met_at || null;
  const sharedBlock = shared_notes.map((s) => s.text).join("\n\n");

  const detailed: ParsedPersonNote[] = [];

  for (let i = 0; i < peopleIds.length; i += DETAIL_BATCH_SIZE) {
    const batch = peopleIds.slice(i, i + DETAIL_BATCH_SIZE);
    const batchRaw = await completeJson(userId, {
      operation: "capture.parse.details",
      temperature: 0.2,
      maxOutputTokens: CAPTURE_MAX_OUTPUT_TOKENS,
      user: `FULL NOTES:\n${sliced}\n\nSHARED CONTEXT (do not copy wholesale into every source_excerpt):\n${sharedBlock || "(none)"}\n\nEXTRACT FULL DETAILS FOR THESE PEOPLE ONLY:\n${batch
        .map(
          (p, idx) =>
            `${idx + 1}. ${p.name}${p.email ? ` <${p.email}>` : ""}${p.company ? ` @ ${p.company}` : ""}${p.role ? ` — ${p.role}` : ""}`,
        )
        .join("\n")}${hintsPreamble(hints)}`,
      system: `You extract structured contact fields for a batch of people from networking notes.
Return strict JSON:
{
  "people": [
    ${PERSON_FIELD_SHAPE}
  ]
}
Rules:
- Return one object per requested person, same order, same names.
- Extract only facts supported by the notes. Use null / [] when unknown.
- source_excerpt must be that person's specific slice of the original notes — never the entire dump, never shared-only text alone.
- Never invent people or facts. Prefer emails/companies from the request when the notes don't contradict them.
- low_confidence_fields: list field names you had to guess or infer rather than read directly from the notes. Use [] when every extracted field is directly supported.
- interaction_date: YYYY-MM-DD when known for this person/event; else null.
- relationship_score_suggestion: 1=barely know, 2=met once, 3=real conversation, 4=strong, 5=mentor/advocate.
- met_at may use shared event place when the person was clearly there.`,
    });

    const batchParsed = personDetailBatchSchema.parse(JSON.parse(batchRaw));
    for (let j = 0; j < batch.length; j++) {
      const requested = batch[j]!;
      const found =
        batchParsed.people.find(
          (p) =>
            p.name?.trim().toLowerCase() ===
            requested.name.trim().toLowerCase(),
        ) || batchParsed.people[j];

      const merged: ParsedPersonNote = {
        name: requested.name,
        company: found?.company || requested.company || null,
        role: found?.role || requested.role || null,
        location: found?.location || null,
        email: found?.email || requested.email || null,
        linkedin_url: found?.linkedin_url || null,
        met_at: found?.met_at || sharedMetAt,
        topics: found?.topics || [],
        action_items: found?.action_items || [],
        follow_up_recommendation: found?.follow_up_recommendation || null,
        follow_up_days: found?.follow_up_days || null,
        relationship_score_suggestion:
          found?.relationship_score_suggestion || null,
        tags: found?.tags || [],
        summary: found?.summary || null,
        key_facts: found?.key_facts || [],
        opportunities: found?.opportunities || [],
        shared_interests: found?.shared_interests || [],
        suggested_next_message: found?.suggested_next_message || null,
        confidence: found?.confidence || null,
        interaction_date: found?.interaction_date || defaultDate,
        low_confidence_fields: found?.low_confidence_fields || [],
        source_excerpt: found?.source_excerpt || "",
      };

      // Retry once for empty excerpt on multi-person dumps.
      if (!merged.source_excerpt.trim() && peopleIds.length > 1) {
        try {
          const retryRaw = await completeJson(userId, {
            operation: "capture.parse.excerpt-retry",
            temperature: 0.1,
            maxOutputTokens: 2048,
            user: `NOTES:\n${sliced}\n\nPerson: ${merged.name}\nReturn JSON { "source_excerpt": string } with ONLY this person's specific slice of the notes.`,
            system:
              "Return strict JSON with source_excerpt = the person-specific portion of the notes. Never return the whole dump.",
          });
          const retry = parseAiJson<{ source_excerpt?: string }>(retryRaw);
          if (retry.source_excerpt?.trim()) {
            merged.source_excerpt = retry.source_excerpt.trim();
          }
        } catch {
          // Keep empty excerpt; caller still has shared context + fields.
        }
      }

      detailed.push(merged);
    }
  }

  return {
    shared_notes,
    interaction_date: defaultDate,
    people: detailed,
  };
}

export async function parseMultiPersonNotesWithAI(
  userId: string,
  notes: string,
  hints?: CaptureParseHints | null,
): Promise<ParsedMultiPersonNotes> {
  const useTwoPass =
    notes.length >= TWO_PASS_CHAR_THRESHOLD ||
    (hints?.seedPeople?.length || 0) >= 5;

  if (useTwoPass) {
    return parseMultiPersonTwoPass(userId, notes, hints);
  }

  const single = await parseMultiPersonSinglePass(userId, notes, hints);
  // Escalate to two-pass when many people came back (token pressure risk).
  if (single.people.length > DETAIL_BATCH_SIZE) {
    return parseMultiPersonTwoPass(userId, notes, hints);
  }
  return single;
}

export async function createEmbedding(userId: string, text: string) {
  const { backend, apiKey, keyOwner } = await resolveEmbeddingBackend(userId);
  const input = text.slice(0, 8000);
  const model =
    backend === "openai" ? OPENAI_EMBEDDING_MODEL : GEMINI_EMBEDDING_MODEL;

  return withUsage(
    {
      userId,
      operation: "search.embed",
      provider: backend,
      model,
      kind: "embedding",
      keyOwner,
    },
    async (report) => {
      if (backend === "openai") {
        const client = new OpenAI({ apiKey });
        const res = await client.embeddings.create({
          model: OPENAI_EMBEDDING_MODEL,
          input,
        });
        report(tokensFromOpenAi(res));
        const values = res.data[0]?.embedding;
        if (!values?.length) throw new Error("Empty embedding response");
        return values;
      }

      const client = new GoogleGenAI({ apiKey });
      const res = await client.models.embedContent({
        model: GEMINI_EMBEDDING_MODEL,
        contents: input,
      });
      // Gemini's embed endpoint reports no usage metadata — the row stores null tokens
      // rather than a fabricated zero, and counts as volume.
      const values = res.embeddings?.[0]?.values;
      if (!values?.length) throw new Error("Empty embedding response");
      return values;
    },
  );
}

/** Embed many texts in as few network round trips as possible, preserving input order. */
export async function createEmbeddingsBatch(
  userId: string,
  texts: string[],
): Promise<number[][]> {
  if (texts.length === 0) return [];
  const { backend, apiKey, keyOwner } = await resolveEmbeddingBackend(userId);
  const inputs = texts.map((text) => text.slice(0, 8000));
  const model =
    backend === "openai" ? OPENAI_EMBEDDING_MODEL : GEMINI_EMBEDDING_MODEL;

  return withUsage(
    {
      userId,
      operation: "search.embed.batch",
      provider: backend,
      model,
      kind: "embedding",
      keyOwner,
    },
    async (report) => {
      if (backend === "openai") {
        const client = new OpenAI({ apiKey });
        const res = await client.embeddings.create({
          model: OPENAI_EMBEDDING_MODEL,
          input: inputs,
        });
        report(tokensFromOpenAi(res));
        const values = res.data
          .slice()
          .sort((a, b) => a.index - b.index)
          .map((d) => d.embedding);
        if (values.length !== inputs.length || values.some((v) => !v?.length)) {
          throw new Error("Incomplete embedding batch response");
        }
        return values;
      }

      const client = new GoogleGenAI({ apiKey });
      const res = await client.models.embedContent({
        model: GEMINI_EMBEDDING_MODEL,
        contents: inputs,
      });
      // No usage metadata from Gemini embeddings; see createEmbedding.
      const values = res.embeddings?.map((e) => e.values ?? []) ?? [];
      if (values.length !== inputs.length || values.some((v) => !v.length)) {
        throw new Error("Incomplete embedding batch response");
      }
      return values;
    },
  );
}

export function cosineSimilarity(a: number[], b: number[]) {
  let dot = 0;
  let na = 0;
  let nb = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

export async function chatWithNetwork(
  userId: string,
  question: string,
  contactsContext: Array<{
    id: string;
    fullName: string;
    company: string | null;
    title: string | null;
    relationshipScore: number;
    aiSummary: string | null;
    notes: string | null;
    keyFacts?: string[];
    recentMessages?: string[];
    tags: string[];
    relevance: number;
  }>,
  priorTurns: Array<{ role: "user" | "assistant"; content: string }> = [],
  recruitersContext: Array<{
    id: string;
    fullName: string;
    firm: string | null;
    specialty: string[];
    avgRating: number;
    logCount: number;
    personalRating: number | null;
    status: string | null;
    notes: string | null;
    piiUnlocked: boolean;
    relevance: number;
  }> = [],
) {
  const contextBlock = contactsContext
    .map((c, i) => {
      const facts =
        c.keyFacts && c.keyFacts.length
          ? `Key facts: ${c.keyFacts.slice(0, 8).join("; ")}`
          : "";
      const messages =
        c.recentMessages && c.recentMessages.length
          ? `Recent LinkedIn messages:\n${c.recentMessages
              .slice(0, 6)
              .map((m) => `- ${m}`)
              .join("\n")}`
          : "";
      return `${i + 1}. [id=${c.id}] ${c.fullName} | ${c.title || "?"} @ ${c.company || "?"} | score=${c.relationshipScore} | tags=${c.tags.join(", ")} | relevance=${c.relevance.toFixed(2)}\nSummary: ${c.aiSummary || "n/a"}\nNotes: ${(c.notes || "").slice(0, 400)}${facts ? `\n${facts}` : ""}${messages ? `\n${messages}` : ""}`;
    })
    .join("\n\n");

  const recruitersBlock = recruitersContext
    .map((r, i) => {
      const rating = r.avgRating ? (r.avgRating / 10).toFixed(1) : "n/a";
      const personal = r.personalRating
        ? `personal_rating=${r.personalRating}`
        : "not_logged";
      const notes =
        r.piiUnlocked && r.notes
          ? `\nYour notes: ${r.notes.slice(0, 300)}`
          : "";
      return `${i + 1}. [recruiter_id=${r.id}] ${r.fullName} | firm=${r.firm || "?"} | specialty=${(r.specialty || []).join(", ") || "?"} | community_rating=${rating} (logs=${r.logCount}) | ${personal} | status=${r.status || "none"} | relevance=${r.relevance.toFixed(2)}${notes}`;
    })
    .join("\n\n");

  const historyBlock =
    priorTurns.length > 0
      ? priorTurns
          .map(
            (t) => `${t.role === "user" ? "User" : "Assistant"}: ${t.content}`,
          )
          .join("\n\n")
      : "";

  const hasRecruiters = recruitersContext.length > 0;

  const content = await completeJson(userId, {
    operation: "chat.answer",
    temperature: 0.3,
    user: `${historyBlock ? `Prior conversation:\n${historyBlock}\n\n` : ""}Question: ${question}\n\nContacts:\n${contextBlock || "(no contacts found)"}${hasRecruiters ? `\n\nRecruiters:\n${recruitersBlock}` : ""}`,
    system: `You are Orbit, a personal networking assistant.
Answer using the provided contacts${hasRecruiters ? " and recruiters" : ""} (including summaries, notes, key facts, and LinkedIn messages). Never invent people or message content.
Use prior conversation for context when present, but ground every recommendation in the provided lists.
${hasRecruiters ? "When the question is about recruiters, prefer recruiters the user already logged (personal_rating / status present), then highly rated community recruiters. Do not invent email/phone — contact details may be locked." : ""}
Return JSON:
{
  "answer": string,
  "recommendations": [
    {
      "contact_id": string|null,
      "recruiter_id": string|null,
      "name": string,
      "reason": string,
      "suggested_action": string,
      "draft_message": string|null
    }
  ]
}
Only use contact_ids and recruiter_ids from the provided lists. For recruiter recommendations set recruiter_id and leave contact_id null (unless recommending a contact who is also a recruiter).`,
  });

  return parseAiJson<{
    answer: string;
    recommendations: Array<{
      contact_id?: string | null;
      recruiter_id?: string | null;
      name: string;
      reason: string;
      suggested_action: string;
      draft_message: string | null;
    }>;
  }>(content);
}
