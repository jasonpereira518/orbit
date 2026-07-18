import { and, desc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { getDb } from "@/db";
import { aiSuggestions, contacts, interactions } from "@/db/schema";
import { getGeminiClient } from "@/lib/ai";
import { upsertContactEmbedding } from "@/lib/search";

const threadEnrichSchema = z.object({
  summary: z.string(),
  key_facts: z.array(z.string()).default([]),
  open_loops: z.array(z.string()).default([]),
  relationship_score_suggestion: z.number().min(1).max(5).nullable(),
  topics: z.array(z.string()).default([]),
});

export type MessageEnrichmentResult = {
  contactsEnriched: number;
  embeddingsCreated: number;
  scoreSuggestions: number;
  skipped: number;
};

async function summarizeThread(
  userId: string,
  contactName: string,
  transcript: string
) {
  const { client, model } = await getGeminiClient(userId);
  const response = await client.models.generateContent({
    model,
    contents: `Contact: ${contactName}\n\nLinkedIn messages (oldest → newest):\n${transcript}`,
    config: {
      temperature: 0.2,
      responseMimeType: "application/json",
      systemInstruction: `You summarize LinkedIn DM history for a personal networking CRM.
Return strict JSON:
{
  "summary": string,
  "key_facts": string[],
  "open_loops": string[],
  "relationship_score_suggestion": 1-5|null,
  "topics": string[]
}
Rules:
- Only use facts supported by the messages. Do not invent.
- summary: 2-4 sentences covering relationship context and recent substance.
- key_facts: memorable details about the person or conversation.
- open_loops: unanswered asks or promised follow-ups.
- relationship_score_suggestion: 1=barely know, 2=met once, 3=real conversation, 4=strong, 5=mentor/advocate.`,
    },
  });

  const content = response.text;
  if (!content) throw new Error("Empty enrichment response");
  return threadEnrichSchema.parse(JSON.parse(content));
}

function mergeUnique(existing: string[] | null | undefined, incoming: string[]) {
  const set = new Set([...(existing || []), ...incoming].map((s) => s.trim()).filter(Boolean));
  return [...set].slice(0, 40);
}

/**
 * AI-enrich contacts that recently received LinkedIn message imports.
 * Never overwrites manual notes; only fills empty aiSummary or appends message summary prefix.
 */
export async function enrichContactsFromMessages(
  userId: string,
  contactIds: string[],
  options?: { maxContacts?: number }
): Promise<MessageEnrichmentResult> {
  const uniqueIds = [...new Set(contactIds)];
  const maxContacts = options?.maxContacts ?? 40;
  const targetIds = uniqueIds.slice(0, maxContacts);

  if (!targetIds.length) {
    return {
      contactsEnriched: 0,
      embeddingsCreated: 0,
      scoreSuggestions: 0,
      skipped: 0,
    };
  }

  const db = await getDb();
  let contactsEnriched = 0;
  let embeddingsCreated = 0;
  let scoreSuggestions = 0;
  let skipped = 0;

  const contactRows = await db.query.contacts.findMany({
    where: and(eq(contacts.userId, userId), inArray(contacts.id, targetIds)),
  });

  for (const contact of contactRows) {
    const msgs = await db.query.interactions.findMany({
      where: and(
        eq(interactions.userId, userId),
        eq(interactions.contactId, contact.id),
        eq(interactions.interactionType, "linkedin_message")
      ),
      orderBy: [desc(interactions.interactionDate)],
      limit: 80,
    });

    if (msgs.length < 1) {
      skipped++;
      continue;
    }

    const chronological = [...msgs].reverse();
    const transcript = chronological
      .map((m) => {
        const when = m.interactionDate
          ? new Date(m.interactionDate).toISOString().slice(0, 10)
          : "?";
        return `[${when}] ${m.rawNotes || m.aiSummary || ""}`;
      })
      .join("\n")
      .slice(0, 24_000);

    let enriched;
    try {
      enriched = await summarizeThread(userId, contact.fullName, transcript);
    } catch {
      skipped++;
      continue;
    }

    const messageSummary = enriched.summary.trim();
    const nextAiSummary = !contact.aiSummary?.trim()
      ? messageSummary
      : contact.aiSummary.includes(messageSummary.slice(0, 80))
        ? contact.aiSummary
        : `${contact.aiSummary.trim()}\n\nFrom LinkedIn messages: ${messageSummary}`;

    const nextKeyFacts = mergeUnique(contact.keyFacts, [
      ...enriched.key_facts,
      ...enriched.open_loops.map((o) => `Open: ${o}`),
    ]);

    const scoreBump =
      enriched.relationship_score_suggestion &&
      enriched.relationship_score_suggestion > (contact.relationshipScore || 0)
        ? enriched.relationship_score_suggestion
        : null;

    await db
      .update(contacts)
      .set({
        aiSummary: nextAiSummary,
        keyFacts: nextKeyFacts,
        updatedAt: new Date(),
      })
      .where(and(eq(contacts.id, contact.id), eq(contacts.userId, userId)));

    if (scoreBump) {
      await db.insert(aiSuggestions).values({
        userId,
        suggestionType: "score_bump",
        title: `Raise score for ${contact.fullName}?`,
        description: `LinkedIn message history suggests relationship score ${scoreBump} (currently ${contact.relationshipScore}).`,
        relatedContactIds: [contact.id],
        confidenceScore: 70,
        status: "pending",
      });
      scoreSuggestions++;
    }

    const recentSnippets = chronological
      .slice(-12)
      .map((m) => m.rawNotes || "")
      .filter(Boolean)
      .join("\n");

    const embedContent = [
      `LinkedIn messages with ${contact.fullName}`,
      messageSummary,
      ...enriched.key_facts,
      ...enriched.open_loops,
      ...enriched.topics,
      recentSnippets.slice(0, 3000),
    ]
      .filter(Boolean)
      .join("\n");

    await upsertContactEmbedding(
      userId,
      contact.id,
      "linkedin_message",
      embedContent,
      `messages:${contact.id}`
    );
    embeddingsCreated++;
    contactsEnriched++;
  }

  return {
    contactsEnriched,
    embeddingsCreated,
    scoreSuggestions,
    skipped,
  };
}
