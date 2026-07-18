import { GoogleGenAI } from "@google/genai";
import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { userSettings } from "@/db/schema";
import { decrypt } from "@/lib/crypto";
import { z } from "zod";

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

const DEFAULT_MODEL = "gemini-3.5-flash";
const EMBEDDING_MODEL = "gemini-embedding-001";

/** Models retired for new API keys — remap to current Flash. */
const LEGACY_MODEL_MAP: Record<string, string> = {
  "gemini-2.5-flash": DEFAULT_MODEL,
  "gemini-2.5-flash-lite": "gemini-3.1-flash-lite",
  "gpt-4o-mini": DEFAULT_MODEL,
};

export function resolveGeminiModel(model?: string | null) {
  const requested = model?.trim() || DEFAULT_MODEL;
  return LEGACY_MODEL_MAP[requested] || requested;
}

export async function getGeminiClient(userId: string) {
  const db = await getDb();
  const settings = await db.query.userSettings.findFirst({
    where: eq(userSettings.userId, userId),
  });

  let apiKey = process.env.GEMINI_API_KEY;

  if (settings?.geminiApiKeyEncrypted) {
    try {
      apiKey = decrypt(settings.geminiApiKeyEncrypted);
    } catch {
      // fall back to env
    }
  }

  if (!apiKey) {
    throw new Error(
      "No Gemini API key configured. Add one in Settings or set GEMINI_API_KEY."
    );
  }

  return {
    client: new GoogleGenAI({ apiKey }),
    model: resolveGeminiModel(settings?.aiModel),
  };
}

export async function parseNotesWithAI(
  userId: string,
  notes: string
): Promise<ParsedNote> {
  const { client, model } = await getGeminiClient(userId);

  const response = await client.models.generateContent({
    model,
    contents: notes,
    config: {
      temperature: 0.2,
      responseMimeType: "application/json",
      systemInstruction: `You extract structured contact data from networking notes.
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
    },
  });

  const content = response.text;
  if (!content) throw new Error("Empty AI response");

  const parsed = noteParseSchema.parse(JSON.parse(content));
  return parsed;
}

export async function parseMultiPersonNotesWithAI(
  userId: string,
  notes: string
): Promise<ParsedMultiPersonNotes> {
  const { client, model } = await getGeminiClient(userId);

  const response = await client.models.generateContent({
    model,
    contents: notes.slice(0, 100_000),
    config: {
      temperature: 0.2,
      responseMimeType: "application/json",
      systemInstruction: `You extract structured contact data from networking notes that may mention many people.
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
    },
  });

  const content = response.text;
  if (!content) throw new Error("Empty AI response");

  const parsed = multiPersonNoteParseSchema.parse(JSON.parse(content));
  return {
    people: parsed.people.filter((p) => p.name?.trim()),
  };
}

export async function createEmbedding(userId: string, text: string) {
  const { client } = await getGeminiClient(userId);
  const res = await client.models.embedContent({
    model: EMBEDDING_MODEL,
    contents: text.slice(0, 8000),
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
    tags: string[];
    relevance: number;
  }>
) {
  const { client, model } = await getGeminiClient(userId);

  const contextBlock = contactsContext
    .map(
      (c, i) =>
        `${i + 1}. [id=${c.id}] ${c.fullName} | ${c.title || "?"} @ ${c.company || "?"} | score=${c.relationshipScore} | tags=${c.tags.join(", ")} | relevance=${c.relevance.toFixed(2)}\nSummary: ${c.aiSummary || "n/a"}\nNotes: ${(c.notes || "").slice(0, 400)}`
    )
    .join("\n\n");

  const response = await client.models.generateContent({
    model,
    contents: `Question: ${question}\n\nContacts:\n${contextBlock || "(no contacts found)"}`,
    config: {
      temperature: 0.3,
      responseMimeType: "application/json",
      systemInstruction: `You are Orbit, a personal networking assistant.
Answer ONLY using the provided contacts. Never invent people.
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
    },
  });

  const content = response.text;
  if (!content) throw new Error("Empty AI response");
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
