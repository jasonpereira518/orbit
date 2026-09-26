import { and, desc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { getDb } from "@/db";
import { aiSuggestions, contacts, interactions } from "@/db/schema";
import { completeJson, parseAiJson } from "@/lib/ai";
import { upsertContactEmbedding } from "@/lib/search";
import { MAX_BATCH_REQUESTS, submitAiBatch, type BatchRequest } from "@/lib/ai-batch";
import { gateSkips, gateText } from "@/lib/decisions/gates";
import { SKIP_GATE_TUNING } from "@/lib/decisions/catalog";
import { mapPool } from "@/lib/decisions/jev";
import { openEngines, type Engines } from "@/lib/decisions/engine";
import { reportUnlessQuiet } from "@/lib/report-error";
import { fenceUntrusted } from "@/lib/ai-security";

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

const ENRICH_SYSTEM = `You summarize LinkedIn DM history for a personal networking CRM.
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
- relationship_score_suggestion: 1=barely know, 2=met once, 3=real conversation, 4=strong, 5=mentor/advocate.`;

function enrichUserPrompt(contactName: string, transcript: string) {
  return `Contact: ${contactName}\n\nLinkedIn messages (oldest → newest):\n${fenceUntrusted("MESSAGES", transcript)}`;
}

async function summarizeThread(userId: string, contactName: string, transcript: string) {
  const content = await completeJson(userId, {
    operation: "import.enrich",
    temperature: 0.2,
    user: enrichUserPrompt(contactName, transcript),
    system: ENRICH_SYSTEM,
  });

  return threadEnrichSchema.parse(JSON.parse(content));
}

function mergeUnique(existing: string[] | null | undefined, incoming: string[]) {
  const set = new Set([...(existing || []), ...incoming].map((s) => s.trim()).filter(Boolean));
  return [...set].slice(0, 40);
}

type ContactRow = typeof contacts.$inferSelect;
type ThreadContext = {
  contact: ContactRow;
  chronological: Array<typeof interactions.$inferSelect>;
  transcript: string;
};

/**
 * One contact's LinkedIn thread as the model reads it, or null when there is nothing to
 * read. Shared by the inline path and by batch results, which re-read rather than carry a
 * transcript around: what gets written back should reflect the thread as it is now.
 */
async function loadThreadContext(userId: string, contact: ContactRow): Promise<ThreadContext | null> {
  const db = await getDb();
  const msgs = await db.query.interactions.findMany({
    where: and(
      eq(interactions.userId, userId),
      eq(interactions.contactId, contact.id),
      eq(interactions.interactionType, "linkedin_message")
    ),
    orderBy: [desc(interactions.interactionDate)],
    limit: 80,
  });
  if (msgs.length < 1) return null;

  const chronological = [...msgs].reverse();
  // Speaker labels matter more than they look: unlabelled, the model cannot tell "I asked
  // you for coffee" from "you asked me", which is the difference between an open loop the
  // user owes and one they are owed. Rows imported before `interactions.direction` existed
  // have no sender, and are left unlabelled rather than guessed at.
  const transcript = chronological
    .map((m) => {
      const when = m.interactionDate
        ? new Date(m.interactionDate).toISOString().slice(0, 10)
        : "?";
      const who =
        m.direction === "out"
          ? "You: "
          : m.direction === "in"
            ? `${contact.fullName}: `
            : "";
      return `[${when}] ${who}${m.rawNotes || m.aiSummary || ""}`;
    })
    .join("\n")
    .slice(0, 24_000);

  return { contact, chronological, transcript };
}

/** The write half: never overwrites manual notes, appends the message summary instead. */
async function applyThreadEnrichment(
  userId: string,
  thread: ThreadContext,
  enriched: z.infer<typeof threadEnrichSchema>
): Promise<{ scoreSuggested: boolean }> {
  const db = await getDb();
  const { contact, chronological } = thread;
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

  return { scoreSuggested: Boolean(scoreBump) };
}

/**
 * AI-enrich contacts that recently received LinkedIn message imports.
 * Never overwrites manual notes; only fills empty aiSummary or appends message summary prefix.
 */
export async function enrichContactsFromMessages(
  userId: string,
  contactIds: string[],
  options?: { maxContacts?: number; engines?: Engines }
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

  const engines = options?.engines ?? (await openEngines(userId));

  for (const contact of contactRows) {
    const thread = await loadThreadContext(userId, contact);
    if (!thread) {
      skipped++;
      continue;
    }
    // Most LinkedIn threads are a connection note and a thank-you. Summarising those costs
    // a model call to learn that two people are connected, which the connection already
    // says. A decision model that is sure there is nothing here skips the call; without
    // one, every thread is summarised exactly as before.
    if (await gateSkips(engines, "enrich", { contact: contact.fullName, messages: gateText(thread.transcript) })) {
      skipped++;
      continue;
    }

    let enriched;
    try {
      enriched = await summarizeThread(userId, contact.fullName, thread.transcript);
    } catch (err) {
      // Skipped rather than failing the import; reported unless it is the person's own key.
      reportUnlessQuiet(err, { where: "job.message-enrichment", userId, extra: { contactId: contact.id } });
      skipped++;
      continue;
    }

    const applied = await applyThreadEnrichment(userId, thread, enriched);
    if (applied.scoreSuggested) scoreSuggestions++;
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

/* ------------------------------------------------------------------------- batch ----- */

/** What a submitted enrichment batch needs to map its answers back onto. */
export type EnrichBatchPayload = { items: Array<{ customId: string; contactId: string }> };

/**
 * Enriches through the provider's Batch API: half price, and nobody is waiting — the import
 * has already finished by the time this runs. Contacts the batch could not be submitted for
 * (no key, allowance spent, provider refused) are enriched the ordinary way instead, so the
 * feature never depends on batching being available.
 */
export async function enrichContactsFromMessagesBatched(
  userId: string,
  contactIds: string[],
  options?: { maxContacts?: number; engines?: Engines }
): Promise<{ submitted: number; inline: MessageEnrichmentResult | null }> {
  const uniqueIds = [...new Set(contactIds)].slice(0, options?.maxContacts ?? 40);
  if (!uniqueIds.length) return { submitted: 0, inline: null };

  const db = await getDb();
  const contactRows = await db.query.contacts.findMany({
    where: and(eq(contacts.userId, userId), inArray(contacts.id, uniqueIds)),
  });

  const engines = options?.engines ?? (await openEngines(userId));
  const threads: Array<{ contact: (typeof contactRows)[number]; transcript: string }> = [];
  for (const contact of contactRows) {
    const thread = await loadThreadContext(userId, contact);
    if (thread) threads.push({ contact, transcript: thread.transcript });
  }
  // Gated together rather than one at a time: nobody is waiting on this, but a batch of 40
  // threads asked in series would spend eight seconds deciding what not to ask about.
  const worthAsking = await mapPool(threads, SKIP_GATE_TUNING.concurrency, async (t) =>
    !(await gateSkips(engines, "enrich", { contact: t.contact.fullName, messages: gateText(t.transcript) }))
  );

  const requests: BatchRequest[] = [];
  const items: EnrichBatchPayload["items"] = [];
  for (const [i, { contact, transcript }] of threads.entries()) {
    if (!worthAsking[i]) continue;
    const customId = `c${items.length}`;
    items.push({ customId, contactId: contact.id });
    requests.push({
      customId,
      system: ENRICH_SYSTEM,
      user: enrichUserPrompt(contact.fullName, transcript),
      temperature: 0.2,
    });
  }
  if (!requests.length) return { submitted: 0, inline: null };

  let submitted = 0;
  const unsent: string[] = [];
  for (let i = 0; i < requests.length; i += MAX_BATCH_REQUESTS) {
    const slice = requests.slice(i, i + MAX_BATCH_REQUESTS);
    const sliceItems = items.slice(i, i + MAX_BATCH_REQUESTS);
    const jobId = await submitAiBatch(userId, "import.enrich", slice, { items: sliceItems } satisfies EnrichBatchPayload);
    if (jobId) submitted += slice.length;
    else unsent.push(...sliceItems.map((it) => it.contactId));
  }

  const inline = unsent.length ? await enrichContactsFromMessages(userId, unsent) : null;
  return { submitted, inline };
}

/**
 * Writes one batched answer back. Re-reads the contact and the thread, so an answer that
 * arrives after the person edited the contact still merges rather than overwrites.
 */
export async function applyEnrichmentOutcome(
  userId: string,
  contactId: string,
  raw: string
): Promise<"enriched" | "skipped"> {
  const db = await getDb();
  const contact = await db.query.contacts.findFirst({
    where: and(eq(contacts.userId, userId), eq(contacts.id, contactId)),
  });
  if (!contact) return "skipped";
  const thread = await loadThreadContext(userId, contact);
  if (!thread) return "skipped";

  const parsed = threadEnrichSchema.safeParse(parseAiJson(raw));
  if (!parsed.success) return "skipped";
  await applyThreadEnrichment(userId, thread, parsed.data);
  return "enriched";
}
