import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { getDb } from "@/db";
import { contacts, interactions, reminders } from "@/db/schema";
import { completeJson } from "@/lib/ai";
import { formatHowMetSummary } from "@/lib/met-context";

const draftSchema = z.object({
  body: z.string().min(1),
});

export type FollowUpDraft = {
  body: string;
  contactId: string;
  contactName: string;
};

function buildConversationTranscript(
  rows: Array<{
    interactionType: string;
    interactionDate: Date | null;
    aiSummary: string | null;
    rawNotes: string | null;
  }>
) {
  return rows
    .map((i) => {
      const text = (i.rawNotes || i.aiSummary || "").trim();
      if (!text) return null;
      const when = i.interactionDate
        ? new Date(i.interactionDate).toISOString().slice(0, 10)
        : "?";
      return `[${when} · ${i.interactionType}] ${text.slice(0, 600)}`;
    })
    .filter(Boolean)
    .join("\n")
    .slice(0, 12_000);
}

type ContactRow = typeof contacts.$inferSelect;

async function loadContactContext(userId: string, contactId: string) {
  const db = await getDb();
  const contact = await db.query.contacts.findFirst({
    where: and(eq(contacts.id, contactId), eq(contacts.userId, userId)),
  });
  if (!contact) throw new Error("Contact not found");

  const recent = await db.query.interactions.findMany({
    where: and(
      eq(interactions.userId, userId),
      eq(interactions.contactId, contact.id)
    ),
    orderBy: [desc(interactions.interactionDate)],
    limit: 25,
  });

  return { contact, recent };
}

function buildProfileBlock(contact: ContactRow) {
  const howMet = formatHowMetSummary({
    metContext: contact.metContext,
    dateMet: contact.dateMet,
    howMet: contact.howMet,
  });

  return [
    `Name: ${contact.fullName}`,
    contact.preferredName ? `Preferred name: ${contact.preferredName}` : null,
    contact.title ? `Role: ${contact.title}` : null,
    contact.company ? `Company: ${contact.company}` : null,
    contact.location ? `Location: ${contact.location}` : null,
    howMet ? `How you met: ${howMet}` : null,
    contact.aiSummary?.trim()
      ? `Relationship summary: ${contact.aiSummary.trim()}`
      : null,
    contact.notes?.trim()
      ? `Notes: ${contact.notes.trim().slice(0, 600)}`
      : null,
    contact.keyFacts?.length
      ? `Key facts: ${contact.keyFacts.join("; ")}`
      : null,
  ]
    .filter(Boolean)
    .join("\n");
}

async function draftFromContext(input: {
  userId: string;
  contact: ContactRow;
  recent: Array<{
    interactionType: string;
    interactionDate: Date | null;
    aiSummary: string | null;
    rawNotes: string | null;
  }>;
  userGoals: string[];
  reminderBlock?: string | null;
}): Promise<FollowUpDraft> {
  const contactName = input.contact.preferredName || input.contact.fullName;
  const profileBlock = buildProfileBlock(input.contact);
  const transcript = buildConversationTranscript(input.recent);
  const goalsBlock =
    input.userGoals.length > 0
      ? `Your active goals: ${input.userGoals.join("; ")}`
      : "Your active goals: (none specified)";

  const content = await completeJson(input.userId, {
    temperature: 0.5,
    system: `You draft warm, specific follow-up messages for a personal networking CRM called Orbit.
The user is following up with someone they already know — not cold outreach.

Return strict JSON: { "body": string }

Rules:
- Write in first person as the user, ready to send (LinkedIn DM, text, or short email).
- Ground the message in the conversation history and reminder context. Reference a concrete detail when available.
- Keep it natural and concise: roughly 40–120 words. No subject line.
- Avoid spammy language, fake familiarity, exaggerated claims, and generic "just checking in".
- Do not invent facts, meetings, or shared history that are not in the context.
- If conversation history is thin, lean on the reminder title/notes and known profile details.
- Prefer a soft, specific CTA (one ask) over a laundry list.`,
    user: `${goalsBlock}

Contact:
${profileBlock}

${input.reminderBlock?.trim() || "Reminder: Warm follow-up from contact profile"}

Conversation history (newest first):
${transcript || "(no interactions logged yet)"}`,
  });

  const parsed = draftSchema.parse(JSON.parse(content));
  return {
    body: parsed.body.trim(),
    contactId: input.contact.id,
    contactName,
  };
}

/**
 * Draft a warm follow-up message for a reminder, grounded in the contact's
 * interaction history (LinkedIn threads, notes, summaries).
 */
export async function generateFollowUpDraft(
  userId: string,
  reminderId: string,
  userGoals: string[] = []
): Promise<FollowUpDraft> {
  const db = await getDb();

  const reminder = await db.query.reminders.findFirst({
    where: and(eq(reminders.id, reminderId), eq(reminders.userId, userId)),
  });
  if (!reminder) throw new Error("Reminder not found");
  if (!reminder.contactId) {
    throw new Error("This reminder is not linked to a contact");
  }

  const { contact, recent } = await loadContactContext(
    userId,
    reminder.contactId
  );

  const reminderBlock = [
    `Reminder: ${reminder.title}`,
    reminder.description?.trim()
      ? `Reminder notes: ${reminder.description.trim()}`
      : null,
  ]
    .filter(Boolean)
    .join("\n");

  return draftFromContext({
    userId,
    contact,
    recent,
    userGoals,
    reminderBlock,
  });
}

/** Draft a warm follow-up from the contact profile (no reminder required). */
export async function generateContactFollowUpDraft(
  userId: string,
  contactId: string,
  userGoals: string[] = []
): Promise<FollowUpDraft> {
  const { contact, recent } = await loadContactContext(userId, contactId);
  return draftFromContext({
    userId,
    contact,
    recent,
    userGoals,
    reminderBlock: "Reminder: Warm follow-up from contact profile",
  });
}
