import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { getDb } from "@/db";
import { contacts, interactions } from "@/db/schema";
import { completeJson, getAiConfig } from "@/lib/ai";
import { formatHowMetSummary, metContextLabel } from "@/lib/met-context";
import { rebuildContactEmbedding } from "@/lib/search";

const personSummarySchema = z.object({
  summary: z.string().min(1),
});

/**
 * Trim to a word boundary and mark the cut.
 *
 * A hard `slice` ended snippets mid-word: a real profile read "...to ping her after
 * their pl; ... she thinks most teams over-pro." — which looks like corrupted data
 * rather than an abridged note. This is the summary Orbit falls back to whenever the AI
 * provider is missing or failing, so it is exactly what is on screen if a key runs out
 * mid-demo. Falls back to a hard cut only when a single word is longer than the budget.
 */
function clip(text: string, max: number) {
  const trimmed = text.trim();
  if (trimmed.length <= max) return trimmed;
  const cut = trimmed.slice(0, max);
  const lastSpace = cut.lastIndexOf(" ");
  const body = lastSpace > max * 0.6 ? cut.slice(0, lastSpace) : cut;
  return `${body.replace(/[\s,;:.\u2013\u2014-]+$/, "")}\u2026`;
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
    // `formatHowMetSummary` joins context, date and details with "·" for the profile
    // card's label. Dropping that into prose produced "You met through Jul 3, 2026 ·
    // AWS Summit — hallway track…", so it is introduced as a label here too.
    parts.push(`How you met: ${met}.`);
  } else if (metContextLabel(input.metContext)) {
    parts.push(`You connected via ${metContextLabel(input.metContext)}.`);
  }
  if (input.notes?.trim()) {
    parts.push(clip(input.notes, 280));
  }
  if (input.interactionSnippets.length > 0) {
    const covered = input.interactionSnippets.slice(0, 3).join("; ");
    // No trailing period when the last snippet was clipped — "over-pro….' reads worse
    // than either mark on its own.
    parts.push(
      `Recent conversations covered: ${covered}${covered.endsWith("\u2026") ? "" : "."}`
    );
  }
  return clip(parts.join(" "), 1200);
}

/**
 * Builds (or rebuilds) a person-level AI summary covering who they are,
 * how you met, and what you've talked about. Persists to contacts.ai_summary.
 */
export async function generateAndStorePersonSummary(
  userId: string,
  contactId: string,
  options?: { force?: boolean }
) {
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
    return contact.aiSummary;
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

  try {
    await getAiConfig(userId);
    const content = await completeJson(userId, {
    operation: "contact.summary",
      temperature: 0.3,
      user: `Profile:\n${profileBlock}\n\nInteractions (newest first):\n${transcript}`,
      system: `You write concise relationship memory for a personal networking CRM called Orbit.
Return strict JSON: { "summary": string }

Write 2–4 sentences that cover:
1) who this person is (role/company when known),
2) how the user met them (context, date, details),
3) what they have talked about or the relationship substance so far.

Rules:
- Use only facts supported by the profile and interactions. Do not invent.
- Prefer concrete topics and context over generic praise.
- Write in second person about the relationship ("You met…", "You've talked about…").
- Keep under 90 words.`,
    });
    summary = personSummarySchema.parse(JSON.parse(content)).summary.trim();
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
        clip(s.replace(/^\[[^\]]+\]\s*/, ""), 120)
      ),
    });
  }

  if (!summary?.trim()) return contact.aiSummary;

  await db
    .update(contacts)
    .set({
      aiSummary: summary.trim(),
      updatedAt: new Date(),
    })
    .where(and(eq(contacts.id, contactId), eq(contacts.userId, userId)));

  await rebuildContactEmbedding(userId, contactId);

  return summary.trim();
}
