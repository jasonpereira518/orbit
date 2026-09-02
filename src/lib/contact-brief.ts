import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { getDb } from "@/db";
import { contactBriefs, contacts, interactions } from "@/db/schema";
import { completeJson, getAiConfig } from "@/lib/ai";
import { formatHowMetSummary, metContextLabel } from "@/lib/met-context";
import { rebuildContactEmbedding } from "@/lib/search";
import { isoDay } from "@/lib/suggested-reminder-utils";

const contactBriefSchema = z.object({
  summary: z.string().min(1),
  standing: z.string().min(1).max(600),
});

export type ContactBrief = typeof contactBriefs.$inferSelect;

export type RecentDiscussion = {
  interactionId: string;
  dateIso: string;
  line: string;
};
export const RECENT_DISCUSSIONS_LIMIT = 5;

function firstSentence(text: string) {
  const line = text.split(/\n/)[0]?.trim() || text.trim();
  const m = line.match(/^(.+?[.!?])(\s|$)/);
  const s = (m ? m[1] : line).trim();
  return s.length > 120 ? `${s.slice(0, 117)}…` : s;
}

export function buildRecentDiscussions(
  rows: {
    id: string;
    interactionDate: Date | string;
    interactionType: string;
    aiSummary: string | null;
    rawNotes: string | null;
  }[]
): RecentDiscussion[] {
  return [...rows]
    .sort(
      (a, b) =>
        new Date(b.interactionDate).getTime() -
        new Date(a.interactionDate).getTime()
    )
    .map((r) => {
      const text = (r.aiSummary || r.rawNotes || "").trim();
      if (!text) return null;
      return {
        interactionId: r.id,
        dateIso: isoDay(new Date(r.interactionDate)),
        line: firstSentence(text),
      };
    })
    .filter((x): x is RecentDiscussion => x !== null)
    .slice(0, RECENT_DISCUSSIONS_LIMIT);
}

export function isBriefStale(
  brief: { generatedAt: Date | string } | null,
  lastInteractionAt: Date | string | null
) {
  if (!brief) return true;
  if (!lastInteractionAt) return false;
  return (
    new Date(brief.generatedAt).getTime() <
    new Date(lastInteractionAt).getTime()
  );
}

export async function getContactBrief(
  userId: string,
  contactId: string
): Promise<ContactBrief | null> {
  const db = await getDb();
  return (
    (await db.query.contactBriefs.findFirst({
      where: and(
        eq(contactBriefs.contactId, contactId),
        eq(contactBriefs.userId, userId)
      ),
    })) ?? null
  );
}

function buildDeterministicSummary(input: {
  fullName: string;
  preferredName?: string | null;
  title?: string | null;
  company?: string | null;
  metContext?: string | null;
  dateMet?: Date | string | null;
  howMet?: string | null;
  notes?: string | null;
  interactionSnippets: string[];
}) {
  const name = input.preferredName?.trim() || input.fullName;
  const roleBits = [input.title, input.company].filter(Boolean).join(" at ");
  const met = formatHowMetSummary({
    metContext: input.metContext,
    dateMet: input.dateMet,
    howMet: input.howMet,
  });

  const parts: string[] = [];
  parts.push(
    roleBits
      ? `${name} is ${roleBits}.`
      : `${name} is in your orbit.`
  );
  if (met) {
    parts.push(`You met through ${met}.`);
  } else if (metContextLabel(input.metContext)) {
    parts.push(`You connected via ${metContextLabel(input.metContext)}.`);
  }
  if (input.notes?.trim()) {
    parts.push(input.notes.trim().slice(0, 280));
  }
  if (input.interactionSnippets.length > 0) {
    parts.push(
      `Recent conversations covered: ${input.interactionSnippets
        .slice(0, 3)
        .join("; ")}.`
    );
  }
  return parts.join(" ").slice(0, 1200);
}

/**
 * Builds (or rebuilds) a person-level AI brief covering who they are, how you met,
 * what you've talked about, and where things currently stand. Persists to
 * `contacts.ai_summary` (the narrative summary) and `contact_briefs` (summary +
 * standing + deterministic recent discussions).
 */
export async function generateAndStoreContactBrief(
  userId: string,
  contactId: string,
  options?: { force?: boolean }
): Promise<{ summary: string | null; standing: string | null } | null> {
  const db = await getDb();
  const contact = await db.query.contacts.findFirst({
    where: and(eq(contacts.id, contactId), eq(contacts.userId, userId)),
    with: { contactTags: { with: { tag: true } } },
  });
  if (!contact) return null;

  const recent = await db.query.interactions.findMany({
    where: and(
      eq(interactions.userId, userId),
      eq(interactions.contactId, contactId)
    ),
    orderBy: [desc(interactions.interactionDate)],
    limit: 20,
  });

  const interactionSnippets = recent
    .map((i) => {
      const text = (i.aiSummary || i.rawNotes || "").trim();
      if (!text) return null;
      const when = i.interactionDate
        ? new Date(i.interactionDate).toISOString().slice(0, 10)
        : "?";
      return `[${when} · ${i.interactionType}] ${text.slice(0, 400)}`;
    })
    .filter(Boolean) as string[];

  const hasSignal =
    Boolean(contact.howMet?.trim()) ||
    Boolean(contact.metContext) ||
    Boolean(contact.notes?.trim()) ||
    Boolean(contact.title || contact.company) ||
    interactionSnippets.length > 0;

  if (!hasSignal && !options?.force) {
    return { summary: contact.aiSummary, standing: null };
  }

  const profileBlock = [
    `Name: ${contact.fullName}`,
    contact.preferredName ? `Preferred name: ${contact.preferredName}` : null,
    contact.title ? `Role: ${contact.title}` : null,
    contact.company ? `Company: ${contact.company}` : null,
    contact.location ? `Location: ${contact.location}` : null,
    contact.industry ? `Industry: ${contact.industry}` : null,
    formatHowMetSummary({
      metContext: contact.metContext,
      dateMet: contact.dateMet,
      howMet: contact.howMet,
    })
      ? `How you met: ${formatHowMetSummary({
          metContext: contact.metContext,
          dateMet: contact.dateMet,
          howMet: contact.howMet,
        })}`
      : null,
    contact.notes?.trim() ? `Notes: ${contact.notes.trim().slice(0, 800)}` : null,
    contact.contactTags?.length
      ? `Tags: ${contact.contactTags.map((ct) => ct.tag.name).join(", ")}`
      : null,
    contact.keyFacts?.length
      ? `Key facts: ${contact.keyFacts.join("; ")}`
      : null,
  ]
    .filter(Boolean)
    .join("\n");

  const transcript =
    interactionSnippets.length > 0
      ? interactionSnippets.join("\n").slice(0, 12_000)
      : "(no interactions logged yet)";

  let summary: string | null = null;
  let standing: string | null = null;
  let model: string | null = null;

  try {
    const config = await getAiConfig(userId);
    const content = await completeJson(userId, {
      operation: "contact.brief",
      temperature: 0.3,
      user: `Profile:\n${profileBlock}\n\nInteractions (newest first):\n${transcript}`,
      system: `You write concise relationship memory for a personal networking CRM called Orbit.
Return strict JSON: { "summary": string, "standing": string }
summary — 2–4 sentences as before (who, how met, what discussed).
standing — 2–3 sentences on WHERE THINGS STAND RIGHT NOW: the most recent thread, anything the user owes or is waiting on, and the natural next step. Present tense, second person, under 70 words, grounded only in the interactions. If nothing is open, say so plainly.

Write 2–4 sentences for summary that cover:
1) who this person is (role/company when known),
2) how the user met them (context, date, details),
3) what they have talked about or the relationship substance so far.

Rules:
- Use only facts supported by the profile and interactions. Do not invent.
- Prefer concrete topics and context over generic praise.
- Write in second person about the relationship ("You met…", "You've talked about…").
- Keep summary under 90 words.`,
    });
    const parsed = contactBriefSchema.parse(JSON.parse(content));
    summary = parsed.summary.trim();
    standing = parsed.standing.trim();
    model = config.model;
  } catch {
    summary = buildDeterministicSummary({
      fullName: contact.fullName,
      preferredName: contact.preferredName,
      title: contact.title,
      company: contact.company,
      metContext: contact.metContext,
      dateMet: contact.dateMet,
      howMet: contact.howMet,
      notes: contact.notes,
      interactionSnippets: interactionSnippets.map((s) =>
        s.replace(/^\[[^\]]+\]\s*/, "").slice(0, 120)
      ),
    });
    standing = summary;
    model = null;
  }

  if (!summary?.trim()) return { summary: contact.aiSummary, standing: null };

  await db
    .update(contacts)
    .set({
      aiSummary: summary.trim(),
      updatedAt: new Date(),
    })
    .where(and(eq(contacts.id, contactId), eq(contacts.userId, userId)));

  const recentRows = recent.map((i) => ({
    id: i.id,
    interactionDate: i.interactionDate,
    interactionType: i.interactionType,
    aiSummary: i.aiSummary,
    rawNotes: i.rawNotes,
  }));
  await db
    .insert(contactBriefs)
    .values({
      contactId,
      userId,
      standing,
      recentDiscussions: buildRecentDiscussions(recentRows),
      generatedAt: new Date(),
      basisInteractionId: recent[0]?.id ?? null,
      model,
    })
    .onConflictDoUpdate({
      target: contactBriefs.contactId,
      set: {
        standing,
        recentDiscussions: buildRecentDiscussions(recentRows),
        generatedAt: new Date(),
        basisInteractionId: recent[0]?.id ?? null,
        model,
      },
    });

  await rebuildContactEmbedding(userId, contactId).catch(() => null);

  return { summary: summary.trim(), standing };
}
