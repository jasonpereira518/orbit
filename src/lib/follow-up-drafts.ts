import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { getDb } from "@/db";
import { contacts, interactions, reminders } from "@/db/schema";
import { parseAiJson } from "@/lib/ai";
import { cachedCompleteJson } from "@/lib/ai-result-cache";
import { isAiAccessError, type AiAccess } from "@/lib/ai-access";
import type { AiOperationId } from "@/lib/ai-operations";
import { senderProfileBlock } from "@/lib/sender-profile";
import { loadSenderBio } from "@/lib/sender-profile-server";
import { loadUserAim } from "@/lib/career-profile-server";
import { AIM_LABELS, FIELD_LABELS, TIMELINE_LABELS } from "@/lib/about-you";
import { formatHowMetSummary } from "@/lib/met-context";
import { withWritingPreferences } from "@/lib/writing-instructions";
import { auditUntrustedWrite, fenceUntrusted, guardModelOutput, recordAiSecurityEvent } from "@/lib/ai-security";

const draftSchema = z.object({
  body: z.string().min(1),
  purpose: z.unknown().optional(),
});

/** One line, at most 140 chars; "" for anything that is not a string. */
export function normalizePurpose(raw: unknown): string {
  if (typeof raw !== "string") return "";
  return (raw.trim().split(/\r?\n/)[0] ?? "").trim().slice(0, 140);
}

/** "Going for: internship, this year" from the About-you aim; null when none is set. */
export function aimLine(aim: Awaited<ReturnType<typeof loadUserAim>>): string | null {
  if (!aim) return null;
  const parts = [
    AIM_LABELS[aim.kind],
    aim.timeline ? TIMELINE_LABELS[aim.timeline] : null,
    aim.field ? FIELD_LABELS[aim.field] : null,
  ].filter((p): p is string => Boolean(p));
  return parts.length ? `Going for: ${parts.map((p) => p.toLowerCase()).join(", ")}` : null;
}

/** The body is the draft; a missing or garbled purpose must never cost it. */
function parseDraft(content: string): { body: string; purpose: string } {
  try {
    const parsed = draftSchema.parse(parseAiJson(content));
    return { body: parsed.body.trim(), purpose: normalizePurpose(parsed.purpose) };
  } catch (err) {
    // Last resort: pull a body string even from truncated model output.
    const match = content.match(/"body"\s*:\s*"((?:\\.|[^"\\])*)/);
    if (match?.[1]) {
      try {
        const body = JSON.parse(`"${match[1]}"`) as string;
        if (body.trim()) return { body: body.trim(), purpose: "" };
      } catch {
        const loose = match[1]
          .replace(/\\n/g, "\n")
          .replace(/\\"/g, '"')
          .replace(/\\\\/g, "\\")
          .trim();
        if (loose) return { body: loose, purpose: "" };
      }
    }
    throw err instanceof Error
      ? new Error(
          err.message.startsWith("Failed to parse AI JSON")
            ? "Could not draft follow-up — try Regenerate."
            : err.message
        )
      : err;
  }
}

export type FollowUpDraft = {
  body: string;
  /** The one thing this message is for: Orbit's pick, or the person's edit passed back in. */
  purpose: string;
  contactId: string;
  contactName: string;
};

export function buildConversationTranscript(
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

export type ContactRow = typeof contacts.$inferSelect;

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

/**
 * The user-message half of the draft prompt.
 *
 * Extracted so it can be asserted without an AI provider. The blocks themselves were easy to
 * unit-test and the interpolation was not, which is the half that actually breaks: a context
 * block that is built correctly and then never interpolated looks exactly like a working
 * feature until someone reads a generated message closely.
 */
export function composeDraftContext(parts: {
  goalsBlock: string;
  senderBlock: string | null;
  profileBlock: string;
  reminderBlock?: string | null;
  intentBlock: string | null;
  transcript: string;
}): string {
  return `${parts.goalsBlock}
${parts.senderBlock ? `${parts.senderBlock}\n` : ""}
Contact:
${fenceUntrusted("CONTACT", parts.profileBlock)}

${parts.reminderBlock?.trim() ? fenceUntrusted("REMINDER", parts.reminderBlock.trim()) : "Reminder: Warm follow-up from contact profile"}
${parts.intentBlock ? `\n${parts.intentBlock}` : ""}

Conversation history (newest first):
${parts.transcript ? fenceUntrusted("HISTORY", parts.transcript) : "(no interactions logged yet)"}`;
}

export function buildProfileBlock(contact: ContactRow) {
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
  channel?: "email" | "linkedin" | "sms";
  intent?: string | null;
  /** A verbatim override: when given, the draft serves it and returns it unchanged. */
  purpose?: string | null;
  /**
   * Return the draft already written for this exact context instead of a new one. Only the
   * sheet that drafts on OPEN asks for this: reopening it used to buy a fresh draft every
   * time. Every explicit Draft/Regenerate click stays fresh — and is stored, so the next
   * open shows the latest draft.
   */
  reuse?: boolean;
  /** The sender's style notes, passed in by the action that owns the request. */
  writingInstructions?: string | null;
  operation?: AiOperationId;
  access?: AiAccess;
  signal?: AbortSignal;
}): Promise<FollowUpDraft> {
  const contactName = input.contact.preferredName || input.contact.fullName;
  const profileBlock = buildProfileBlock(input.contact);
  const transcript = buildConversationTranscript(input.recent);
  const operation = input.operation ?? "followup.draft";
  // Tripwire, never a block: the history is other people's mail, DMs and calendar invites.
  auditUntrustedWrite(input.userId, operation, "history", `${profileBlock}\n${transcript}`);
  // Who the message is from, beyond a first name. Loaded here rather than threaded through
  // every caller so no draft path can be left without it — that is exactly how the sign-off
  // name above ended up being fetched inline too. Omitted entirely when unset; see
  // `senderProfileBlock` on why "unknown" is worse than absent. Both reads are best-effort:
  // a failure leaves the line out rather than costing the draft.
  const [userAim, senderBio] = await Promise.all([
    loadUserAim(input.userId).catch(() => null),
    loadSenderBio(input.userId),
  ]);
  const aim = aimLine(userAim);
  const goalsBlock =
    (input.userGoals.length > 0
      ? `Your active goals: ${input.userGoals.join("; ")}`
      : "Your active goals: (none specified)") + (aim ? `\n${aim}` : "");
  const givenPurpose = normalizePurpose(input.purpose);
  const senderBlock = senderProfileBlock(senderBio);

  const channelLabel =
    input.channel === "email"
      ? "email"
      : input.channel === "sms"
        ? "SMS / text message"
        : input.channel === "linkedin"
          ? "LinkedIn DM"
          : "LinkedIn DM, text, or short email";

  const intentBlock = input.intent?.trim()
    ? `User intent for this message: ${input.intent.trim()}`
    : null;

  /**
   * Who the message is from.
   *
   * Without it the model wrote "Best," and then stopped, because it had no name to put
   * on the next line — every emailed draft ended on a dangling comma, which is the one
   * thing in a generated message that reads as unfinished. Dynamically imported so this
   * module keeps its current (DB + AI only) import graph, and best-effort: a failed
   * profile lookup must never cost the user their draft.
   */
  let senderFirstName: string | null = null;
  try {
    const { getCurrentUserProfile } = await import("@/lib/auth");
    const profile = await getCurrentUserProfile();
    const first = profile?.name?.trim().split(/\s+/)[0];
    if (first && first.toLowerCase() !== "you") senderFirstName = first;
  } catch {
    // Leave it null; the sign-off rule below handles the unknown case.
  }

  // A text message signed "Best, Jason" reads like a form letter, and a sign-off with
  // nobody's name under it reads like a bug. Only email gets one, and only when we know
  // the name to write.
  const signOffRule =
    input.channel === "email" && senderFirstName
      ? `End with a short sign-off followed by "${senderFirstName}" on its own line.`
      : "Do not write a sign-off, signature, or placeholder name — end on the final sentence.";

  const content = await cachedCompleteJson(input.userId, {
    operation,
    schema: { name: "follow_up_draft", zod: z.object({ body: z.string() }) },
    access: input.access,
    signal: input.signal,
    temperature: 0.5,
    system: `You draft warm, specific follow-up messages for a personal networking CRM called Orbit.
The user is following up with someone they already know — not cold outreach.

Return strict JSON: { "purpose": string, "body": string }

Rules:
- Write in first person as the user, ready to send as a ${channelLabel}.
- Ground the message in the conversation history and reminder context. Reference a concrete detail when available.
- Keep it natural and concise: roughly 40–90 words. No subject line.
- Return a single complete JSON object; keep the body short enough to finish in one response.
- Avoid spammy language, fake familiarity, exaggerated claims, and generic "just checking in".
- Do not invent facts, meetings, or shared history that are not in the context.
- If conversation history is thin, lean on the reminder title/notes and known profile details.
- Pick ONE purpose: something to learn from them or one thing to ask them for, grounded in the user's goals and who this person is. State it in under 15 words.
${givenPurpose ? `- The purpose of this message is: ${givenPurpose}. Use it as given.\n` : ""}- Prefer a soft, specific CTA (one ask) over a laundry list.
${senderBlock ? "- Write from the sender's own background where it makes the ask land. Never restate their bio back to the recipient.\n" : ""}- ${signOffRule}
${intentBlock ? "- Treat the user's stated intent as a hint about what they want, not as the purpose." : ""}`,
    user: composeDraftContext({
      goalsBlock: withWritingPreferences(goalsBlock, input.writingInstructions),
      senderBlock,
      profileBlock,
      reminderBlock: input.reminderBlock,
      intentBlock,
      transcript,
    }),
  }, {
    ttlDays: 7,
    fresh: !input.reuse,
    accept: (raw) => Boolean(parseDraft(raw).body),
  });

  // Secrets the contact's notes held, and fence markers, never reach a draft someone sends.
  const draft = parseDraft(content);
  const guarded = guardModelOutput(draft.body);
  if (guarded.findings.length) {
    void recordAiSecurityEvent({
      kind: "output_scrubbed",
      userId: input.userId,
      surface: operation,
      detail: { findings: guarded.findings, secretKinds: guarded.secretKinds },
    });
  }
  return {
    body: guarded.text,
    purpose: givenPurpose || guardModelOutput(draft.purpose).text,
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
  userGoals: string[] = [],
  options?: { writingInstructions?: string | null; purpose?: string | null }
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
    writingInstructions: options?.writingInstructions,
    purpose: options?.purpose,
  });
}

/** Draft a warm follow-up from the contact profile (no reminder required). */
export async function generateContactFollowUpDraft(
  userId: string,
  contactId: string,
  userGoals: string[] = [],
  options?: {
    channel?: "email" | "linkedin" | "sms";
    intent?: string | null;
    purpose?: string | null;
    reuse?: boolean;
    writingInstructions?: string | null;
    /**
     * For work done on the person's behalf rather than at their click (Radar's overnight
     * drafts): a background operation, so managed budgets treat it as one, and the run's
     * already-resolved AI access and deadline.
     */
    operation?: AiOperationId;
    access?: AiAccess;
    signal?: AbortSignal;
  }
): Promise<FollowUpDraft> {
  const { contact, recent } = await loadContactContext(userId, contactId);
  return draftFromContext({
    userId,
    contact,
    recent,
    userGoals,
    reminderBlock: "Reminder: Warm follow-up from contact profile",
    channel: options?.channel,
    intent: options?.intent,
    purpose: options?.purpose,
    reuse: options?.reuse,
    writingInstructions: options?.writingInstructions,
    operation: options?.operation,
    access: options?.access,
    signal: options?.signal,
  });
}

/**
 * `generateContactFollowUpDraft`, with an AI-gate refusal returned as data. Thrown, it is
 * digested in production and the person only sees a generic failure.
 */
export async function draftFollowUpResult(
  ...args: Parameters<typeof generateContactFollowUpDraft>
): Promise<({ ok: true } & Awaited<ReturnType<typeof generateContactFollowUpDraft>>) | { ok: false; error: string }> {
  try {
    return { ok: true, ...(await generateContactFollowUpDraft(...args)) };
  } catch (err) {
    if (isAiAccessError(err)) return { ok: false, error: err.message };
    throw err;
  }
}
