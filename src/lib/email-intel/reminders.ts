/**
 * The task an accepted email-backed Radar card becomes.
 *
 * Accepting a card used to schedule a generic "Follow up with X". For a card built from mail
 * that throws away the one useful thing Radar knows: what the email asked for. This writes the
 * reminder the email implies, and records honestly that Orbit inferred it (`origin: implied`,
 * `createdBy: ai`, a confidence, the email's own quote as the excerpt), so it never reads as
 * something the person typed.
 *
 * The person pressing a schedule button is the confirmation, which is why nothing is staged in
 * `suggested_reminders`. Idempotent on (event, contact): pressing it twice moves the date, it
 * does not make a second reminder. The contact's `nextFollowUpAt` moves with it, as in every
 * other scheduling path, because the scorer's "a follow-up is already set" rule reads it.
 */
import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { contacts, emailEvents, reminders } from "@/db/schema";
import { inferReminderActionKind } from "@/lib/reminder-action-kind";
import { getInboxListId } from "@/lib/reminder-lists";
import type { EmailEventKind } from "./types";

const DAY_MS = 86_400_000;
const TITLE_MAX = 140;

export function reminderTextFor(args: {
  kind: Exclude<EmailEventKind, "other">;
  onThread: boolean;
  name: string;
  company: string | null;
  role: string | null;
  ask: string | null;
}): string {
  const { kind, onThread, name, company, role, ask } = args;
  let title: string;
  if (onThread && ask) {
    // The email's own words, already schema-checked at extraction: short, no address or link.
    title = ask;
  } else if (kind === "job_posting") {
    title = onThread
      ? `Reply to ${name} about ${role ?? "the role"}${company ? ` at ${company}` : ""}`
      : `Ask ${name} about ${role ?? "the opening"} at ${company ?? "their company"}`;
  } else if (kind === "process_update") {
    title = onThread
      ? `Follow up with ${name} about ${company ?? "your application"}`
      : `Ask ${name} for a hand with ${company ?? "your application"}`;
  } else if (kind === "news") {
    title = `Reach out to ${name} about ${company ?? "their company"} news`;
  } else {
    title = `Follow up with ${name} about the event`;
  }
  return title.slice(0, TITLE_MAX);
}

export async function scheduleEmailEventReminder(
  userId: string,
  args: { contactId: string; eventId: string; onThread: boolean; days: number; now?: Date }
): Promise<{ reminderId: string; dueDate: string; created: boolean } | null> {
  const db = await getDb();
  const now = args.now ?? new Date();

  const [event] = await db
    .select()
    .from(emailEvents)
    .where(and(eq(emailEvents.id, args.eventId), eq(emailEvents.userId, userId)));
  if (!event || event.dismissedAt || event.kind === "other") return null;
  const contact = await db.query.contacts.findFirst({
    where: and(eq(contacts.id, args.contactId), eq(contacts.userId, userId)),
    columns: { id: true, fullName: true, preferredName: true },
  });
  if (!contact) return null;

  const days = Math.max(1, Math.min(90, args.days));
  const byPreset = new Date(now.getTime() + days * DAY_MS);
  // A deadline the email stated wins over a later preset, but only for the person it asked.
  const due = args.onThread && event.dueAt && event.dueAt > now && event.dueAt < byPreset ? event.dueAt : byPreset;

  const title = reminderTextFor({
    kind: event.kind,
    onThread: args.onThread,
    name: contact.preferredName || contact.fullName,
    company: event.company,
    role: event.role,
    ask: event.asks[0] ?? null,
  });
  const itemHash = createHash("sha256").update(`radar-email:${event.id}:${contact.id}`).digest("hex").slice(0, 32);

  const existing = await db.query.reminders.findFirst({
    where: and(eq(reminders.userId, userId), eq(reminders.itemHash, itemHash)),
  });
  let reminderId: string;
  let created = false;
  if (existing) {
    // Rescheduling moves the date. It does not rewrite what the reminder says.
    await db.update(reminders).set({ dueDate: due, status: "pending" }).where(eq(reminders.id, existing.id));
    reminderId = existing.id;
  } else {
    const inboxId = await getInboxListId(userId);
    const [row] = await db
      .insert(reminders)
      .values({
        userId,
        contactId: contact.id,
        listId: inboxId,
        title,
        description: event.summary,
        dueDate: due,
        reminderType: "ai_suggested",
        actionKind: inferReminderActionKind({ title, description: event.summary, reminderType: "ai_suggested", contactId: contact.id }),
        createdBy: "ai",
        status: "pending",
        origin: "implied",
        confidenceScore: Math.round(event.confidence * 100),
        sourceExcerpt: event.evidenceQuote || null,
        itemHash,
      })
      .returning();
    reminderId = row!.id;
    created = true;
  }

  await db
    .update(contacts)
    .set({ nextFollowUpAt: due, followUpStatus: "pending", updatedAt: new Date() })
    .where(and(eq(contacts.id, contact.id), eq(contacts.userId, userId)));

  return { reminderId, dueDate: due.toISOString(), created };
}
