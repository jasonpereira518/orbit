import OpenAI from "openai";
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

export async function getOpenAIClient(userId: string) {
  const db = await getDb();
  const settings = await db.query.userSettings.findFirst({
    where: eq(userSettings.userId, userId),
  });

  let apiKey = process.env.OPENAI_API_KEY;

  if (settings?.openaiApiKeyEncrypted) {
    try {
      apiKey = decrypt(settings.openaiApiKeyEncrypted);
    } catch {
      // fall back to env
    }
  }

  if (!apiKey) {
    throw new Error(
      "No OpenAI API key configured. Add one in Settings or set OPENAI_API_KEY."
    );
  }

  return {
    client: new OpenAI({ apiKey }),
    model: settings?.aiModel || "gpt-4o-mini",
  };
}

export async function parseNotesWithAI(
  userId: string,
  notes: string
): Promise<ParsedNote> {
  const { client, model } = await getOpenAIClient(userId);

  const response = await client.chat.completions.create({
    model,
    temperature: 0.2,
    response_format: { type: "json_object" },
    messages: [
      {
        role: "system",
        content: `You extract structured contact data from networking notes.
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
      { role: "user", content: notes },
    ],
  });

  const content = response.choices[0]?.message?.content;
  if (!content) throw new Error("Empty AI response");

  const parsed = noteParseSchema.parse(JSON.parse(content));
  return parsed;
}

export async function createEmbedding(userId: string, text: string) {
  const { client } = await getOpenAIClient(userId);
  const res = await client.embeddings.create({
    model: "text-embedding-3-small",
    input: text.slice(0, 8000),
  });
  return res.data[0].embedding;
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
  const { client, model } = await getOpenAIClient(userId);

  const contextBlock = contactsContext
    .map(
      (c, i) =>
        `${i + 1}. [id=${c.id}] ${c.fullName} | ${c.title || "?"} @ ${c.company || "?"} | score=${c.relationshipScore} | tags=${c.tags.join(", ")} | relevance=${c.relevance.toFixed(2)}\nSummary: ${c.aiSummary || "n/a"}\nNotes: ${(c.notes || "").slice(0, 400)}`
    )
    .join("\n\n");

  const response = await client.chat.completions.create({
    model,
    temperature: 0.3,
    response_format: { type: "json_object" },
    messages: [
      {
        role: "system",
        content: `You are Orbit, a personal networking assistant.
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
      {
        role: "user",
        content: `Question: ${question}\n\nContacts:\n${contextBlock || "(no contacts found)"}`,
      },
    ],
  });

  const content = response.choices[0]?.message?.content;
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
