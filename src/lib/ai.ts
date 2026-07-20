import Anthropic from "@anthropic-ai/sdk";
import { GoogleGenAI } from "@google/genai";
import OpenAI from "openai";
import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { userSettings } from "@/db/schema";
import { decrypt } from "@/lib/crypto";
import { z } from "zod";
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

export const noteParseSchema = z.object({
  name: z.string().nullable(),
  company: z.string().nullable(),
  role: z.string().nullable(),
  location: z.string().nullable(),
  email: z.string().nullable(),
  linkedin_url: z.string().nullable(),
  met_at: z.string().nullable(),
  topics: z.array(z.string()).default([]),
  action_items: z.array(z.string()).default([]),
  follow_up_recommendation: z.string().nullable(),
  follow_up_days: z.number().nullable(),
  relationship_score_suggestion: z.number().min(1).max(5).nullable(),
  tags: z.array(z.string()).default([]),
  summary: z.string().nullable(),
  key_facts: z.array(z.string()).default([]),
  opportunities: z.array(z.string()).default([]),
  shared_interests: z.array(z.string()).default([]),
  suggested_next_message: z.string().nullable(),
  confidence: z.number().min(0).max(1).nullable(),
});

export type ParsedNote = z.infer<typeof noteParseSchema>;

export const multiPersonNoteParseSchema = z.object({
  people: z.array(
    noteParseSchema.extend({
      source_excerpt: z.string(),
    })
  ),
});

export type ParsedMultiPersonNotes = z.infer<typeof multiPersonNoteParseSchema>;
export type ParsedPersonNote = ParsedMultiPersonNotes["people"][number];

const GEMINI_EMBEDDING_MODEL = "gemini-embedding-001";
const OPENAI_EMBEDDING_MODEL = "text-embedding-3-small";

/** @deprecated Use resolveAiModel */
export function resolveGeminiModel(model?: string | null) {
  return resolveAiModel("gemini", model);
}

type StoredSettings = {
  aiProvider: string | null;
  aiModel: string | null;
  geminiApiKeyEncrypted: string | null;
  openaiApiKeyEncrypted: string | null;
  anthropicApiKeyEncrypted: string | null;
};

async function loadSettings(userId: string) {
  const db = await getDb();
  return db.query.userSettings.findFirst({
    where: eq(userSettings.userId, userId),
  });
}

function decryptKey(encrypted?: string | null) {
  if (!encrypted) return null;
  try {
    return decrypt(encrypted);
  } catch {
    return null;
  }
}

export function getProviderApiKey(
  provider: AiProvider,
  settings?: StoredSettings | null
): string | null {
  const personal =
    provider === "gemini"
      ? decryptKey(settings?.geminiApiKeyEncrypted)
      : provider === "openai"
        ? decryptKey(settings?.openaiApiKeyEncrypted)
        : decryptKey(settings?.anthropicApiKeyEncrypted);

  if (personal) return personal;

  if (provider === "gemini") return process.env.GEMINI_API_KEY || null;
  if (provider === "openai") return process.env.OPENAI_API_KEY || null;
  return process.env.ANTHROPIC_API_KEY || null;
}

export function hasProviderKey(
  provider: AiProvider,
  settings?: StoredSettings | null
) {
  return Boolean(getProviderApiKey(provider, settings));
}

export function usingEnvKey(
  provider: AiProvider,
  settings?: StoredSettings | null
) {
  const hasPersonal =
    provider === "gemini"
      ? Boolean(settings?.geminiApiKeyEncrypted)
      : provider === "openai"
        ? Boolean(settings?.openaiApiKeyEncrypted)
        : Boolean(settings?.anthropicApiKeyEncrypted);
  if (hasPersonal) return false;
  if (provider === "gemini") return Boolean(process.env.GEMINI_API_KEY);
  if (provider === "openai") return Boolean(process.env.OPENAI_API_KEY);
  return Boolean(process.env.ANTHROPIC_API_KEY);
}

export async function getAiConfig(userId: string) {
  const settings = await loadSettings(userId);
  const provider = resolveAiProvider(settings?.aiProvider);
  const model = resolveAiModel(provider, settings?.aiModel);
  const apiKey = getProviderApiKey(provider, settings);

  if (!apiKey) {
    const meta = AI_PROVIDERS.find((p) => p.id === provider)!;
    throw new Error(
      `No ${meta.label} API key configured. Add one in Settings or set ${meta.envVar}.`
    );
  }

  return { provider, model, apiKey, settings };
}

/** Resolve which embedding API to use for semantic search. */
export async function resolveEmbeddingBackend(
  userId: string
): Promise<{ backend: EmbeddingBackend; apiKey: string }> {
  const settings = await loadSettings(userId);
  const provider = resolveAiProvider(settings?.aiProvider);

  if (provider === "openai") {
    const apiKey = getProviderApiKey("openai", settings);
    if (!apiKey) {
      throw new Error(
        "No OpenAI API key configured for embeddings. Add one in Settings or set OPENAI_API_KEY."
      );
    }
    return { backend: "openai", apiKey };
  }

  if (provider === "gemini") {
    const apiKey = getProviderApiKey("gemini", settings);
    if (!apiKey) {
      throw new Error(
        "No Gemini API key configured for embeddings. Add one in Settings or set GEMINI_API_KEY."
      );
    }
    return { backend: "gemini", apiKey };
  }

  // Anthropic has no embeddings API — prefer OpenAI, then Gemini.
  const openaiKey = getProviderApiKey("openai", settings);
  if (openaiKey) return { backend: "openai", apiKey: openaiKey };

  const geminiKey = getProviderApiKey("gemini", settings);
  if (geminiKey) return { backend: "gemini", apiKey: geminiKey };

  throw new Error(
    "Anthropic has no embeddings API. Add an OpenAI or Gemini key in Settings for search embeddings."
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
    if (end === -1) {
      throw new Error(`Failed to parse AI JSON: ${text.slice(0, 200)}`);
    }
    return JSON.parse(text.slice(start, end + 1)) as T;
  }
}

function normalizeJsonResponse(raw: string) {
  return JSON.stringify(parseAiJson(raw));
}

export async function completeJson(
  userId: string,
  input: {
    system: string;
    user: string;
    temperature?: number;
  }
): Promise<string> {
  const { provider, model, apiKey } = await getAiConfig(userId);
  const temperature = input.temperature ?? 0.2;
  const system = `${input.system}\n\nRespond with valid JSON only. No markdown fences.`;

  if (provider === "gemini") {
    const client = new GoogleGenAI({ apiKey });
    const response = await client.models.generateContent({
      model,
      contents: input.user,
      config: {
        temperature,
        responseMimeType: "application/json",
        systemInstruction: system,
      },
    });
    const content = response.text;
    if (!content) throw new Error("Empty AI response");
    return normalizeJsonResponse(content);
  }

  if (provider === "openai") {
    const client = new OpenAI({ apiKey });
    const response = await client.chat.completions.create({
      model,
      temperature,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: system },
        { role: "user", content: input.user },
      ],
    });
    const content = response.choices[0]?.message?.content;
    if (!content) throw new Error("Empty AI response");
    return normalizeJsonResponse(content);
  }

  const client = new Anthropic({ apiKey });
  const response = await client.messages.create({
    model,
    max_tokens: 4096,
    temperature,
    system,
    messages: [{ role: "user", content: input.user }],
  });
  const block = response.content.find((b) => b.type === "text");
  if (!block || block.type !== "text" || !block.text) {
    throw new Error("Empty AI response");
  }
  return normalizeJsonResponse(block.text);
}

export async function parseNotesWithAI(
  userId: string,
  notes: string
): Promise<ParsedNote> {
  const content = await completeJson(userId, {
    temperature: 0.2,
    user: notes,
    system: `You extract structured contact data from networking notes.
Return strict JSON matching this shape:
{
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
  "confidence": 0-1|null
}
Rules:
- Extract only information supported by the notes.
- Use null when unknown. Do not invent facts.
- Separate facts from guesses; suggestions go in recommendation fields.
- relationship_score_suggestion: 1=barely know, 2=met once, 3=real conversation, 4=strong, 5=mentor/advocate.`,
  });

  return noteParseSchema.parse(JSON.parse(content));
}

export async function parseMultiPersonNotesWithAI(
  userId: string,
  notes: string
): Promise<ParsedMultiPersonNotes> {
  const content = await completeJson(userId, {
    temperature: 0.2,
    user: notes.slice(0, 100_000),
    system: `You extract structured contact data from networking notes that may mention many people.
Return strict JSON matching this shape:
{
  "people": [
    {
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
      "source_excerpt": string
    }
  ]
}
Rules:
- Create one object per distinct person clearly mentioned in the notes.
- Skip vague groups ("a few engineers") with no identifiable person.
- Extract only information supported by the notes. Use null when unknown. Do not invent people or facts.
- source_excerpt must be the relevant slice of the original notes for that person (not the whole dump).
- relationship_score_suggestion: 1=barely know, 2=met once, 3=real conversation, 4=strong, 5=mentor/advocate.
- If the notes only cover one person, return a single-item people array.`,
  });

  const parsed = multiPersonNoteParseSchema.parse(JSON.parse(content));
  return {
    people: parsed.people.filter((p) => p.name?.trim()),
  };
}

export async function createEmbedding(userId: string, text: string) {
  const { backend, apiKey } = await resolveEmbeddingBackend(userId);
  const input = text.slice(0, 8000);

  if (backend === "openai") {
    const client = new OpenAI({ apiKey });
    const res = await client.embeddings.create({
      model: OPENAI_EMBEDDING_MODEL,
      input,
    });
    const values = res.data[0]?.embedding;
    if (!values?.length) throw new Error("Empty embedding response");
    return values;
  }

  const client = new GoogleGenAI({ apiKey });
  const res = await client.models.embedContent({
    model: GEMINI_EMBEDDING_MODEL,
    contents: input,
  });
  const values = res.embeddings?.[0]?.values;
  if (!values?.length) throw new Error("Empty embedding response");
  return values;
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
  }>
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

  const content = await completeJson(userId, {
    temperature: 0.3,
    user: `Question: ${question}\n\nContacts:\n${contextBlock || "(no contacts found)"}`,
    system: `You are Orbit, a personal networking assistant.
Answer ONLY using the provided contacts (including summaries, notes, key facts, and LinkedIn messages). Never invent people or message content.
Return JSON:
{
  "answer": string,
  "recommendations": [
    {
      "contact_id": string,
      "name": string,
      "reason": string,
      "suggested_action": string,
      "draft_message": string|null
    }
  ]
}
Only use contact_ids from the provided list.`,
  });

  return JSON.parse(content) as {
    answer: string;
    recommendations: Array<{
      contact_id: string;
      name: string;
      reason: string;
      suggested_action: string;
      draft_message: string | null;
    }>;
  };
}
