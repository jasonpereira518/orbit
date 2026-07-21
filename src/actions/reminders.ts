"use server";

import { and, eq } from "drizzle-orm";
import { after } from "next/server";
import { revalidatePath } from "next/cache";
import { getDb } from "@/db";
import { reminders } from "@/db/schema";
import { listActiveGoalTexts } from "@/actions/goals";
import { requireUserId, getCurrentUserProfile } from "@/lib/auth";
import { generateFollowUpDraft } from "@/lib/follow-up-drafts";
import {
  completeReminder,
  generateDueFollowUps,
  getDashboardData,
  snoozeReminder,
} from "@/lib/reminders";

export async function fetchDashboard() {
  const userId = await requireUserId();
  const profile = await getCurrentUserProfile();
  // Calendar sync can be slow; don't block the dashboard paint.
  after(() => {
    void import("@/lib/calendar-sync")
      .then(({ syncDueCalendarSubscriptions }) =>
        syncDueCalendarSubscriptions(userId)
      )
      .catch(() => {});
  });
  return getDashboardData(userId, { userName: profile?.name || "You" });
}

export async function createReminder(input: {
  contactId?: string;
  title: string;
  description?: string;
  dueDate?: string;
  reminderType?: string;
}) {
  const userId = await requireUserId();
  const db = await getDb();
  const [row] = await db
    .insert(reminders)
    .values({
      userId,
      contactId: input.contactId,
      title: input.title,
      description: input.description,
      dueDate: input.dueDate ? new Date(input.dueDate) : null,
      reminderType: input.reminderType || "manual",
      createdBy: "user",
      status: "pending",
    })
    .returning();

  revalidatePath("/");
  revalidatePath("/dashboard");
  if (input.contactId) {
    revalidatePath(`/contacts/${input.contactId}`);
    revalidatePath("/graph");
  }
  return row;
}

export async function scheduleContactFollowUp(
  contactId: string,
  days = 7
) {
  const userId = await requireUserId();
  const db = await getDb();
  const { contacts } = await import("@/db/schema");

  const contact = await db.query.contacts.findFirst({
    where: and(eq(contacts.id, contactId), eq(contacts.userId, userId)),
    columns: { id: true, fullName: true, preferredName: true },
  });
  if (!contact) throw new Error("Contact not found");

  const due = new Date();
  due.setDate(due.getDate() + Math.max(1, Math.min(90, days)));
  const name = contact.preferredName || contact.fullName;
  const title = `Follow up with ${name}`;

  const existing = await db.query.reminders.findFirst({
    where: and(
      eq(reminders.userId, userId),
      eq(reminders.contactId, contactId),
      eq(reminders.status, "pending")
    ),
  });

  let row;
  if (existing) {
    const [updated] = await db
      .update(reminders)
      .set({
        title,
        dueDate: due,
        reminderType: "manual",
      })
      .where(eq(reminders.id, existing.id))
      .returning();
    row = updated;
  } else {
    const [created] = await db
      .insert(reminders)
      .values({
        userId,
        contactId,
        title,
        dueDate: due,
        reminderType: "manual",
        createdBy: "user",
        status: "pending",
      })
      .returning();
    row = created;
  }

  await db
    .update(contacts)
    .set({
      nextFollowUpAt: due,
      followUpStatus: "pending",
      updatedAt: new Date(),
    })
    .where(and(eq(contacts.id, contactId), eq(contacts.userId, userId)));

  revalidatePath("/dashboard");
  revalidatePath("/contacts");
  revalidatePath(`/contacts/${contactId}`);
  revalidatePath("/graph");
  return { reminder: row, dueDate: due.toISOString(), days };
}

/** Schedule a follow-up reminder for an absolute calendar date (local YYYY-MM-DD). */
export async function scheduleContactFollowUpAt(
  contactId: string,
  dateIso: string
) {
  const userId = await requireUserId();
  const db = await getDb();
  const { contacts } = await import("@/db/schema");

  const contact = await db.query.contacts.findFirst({
    where: and(eq(contacts.id, contactId), eq(contacts.userId, userId)),
    columns: { id: true, fullName: true, preferredName: true },
  });
  if (!contact) throw new Error("Contact not found");

  const due = new Date(`${dateIso}T12:00:00`);
  if (Number.isNaN(due.getTime())) throw new Error("Invalid date");

  const name = contact.preferredName || contact.fullName;
  const title = `Follow up with ${name}`;

  const existing = await db.query.reminders.findFirst({
    where: and(
      eq(reminders.userId, userId),
      eq(reminders.contactId, contactId),
      eq(reminders.status, "pending")
    ),
  });

  let row;
  if (existing) {
    const [updated] = await db
      .update(reminders)
      .set({
        title,
        dueDate: due,
        reminderType: "manual",
      })
      .where(eq(reminders.id, existing.id))
      .returning();
    row = updated;
  } else {
    const [created] = await db
      .insert(reminders)
      .values({
        userId,
        contactId,
        title,
        dueDate: due,
        reminderType: "manual",
        createdBy: "user",
        status: "pending",
      })
      .returning();
    row = created;
  }

  await db
    .update(contacts)
    .set({
      nextFollowUpAt: due,
      followUpStatus: "pending",
      updatedAt: new Date(),
    })
    .where(and(eq(contacts.id, contactId), eq(contacts.userId, userId)));

  revalidatePath("/dashboard");
  revalidatePath("/contacts");
  revalidatePath(`/contacts/${contactId}`);
  revalidatePath("/graph");
  return { reminder: row, dueDate: due.toISOString() };
}

export async function clearContactFollowUp(contactId: string) {
  const userId = await requireUserId();
  const db = await getDb();
  const { contacts } = await import("@/db/schema");

  await db
    .update(contacts)
    .set({
      nextFollowUpAt: null,
      followUpStatus: "none",
      updatedAt: new Date(),
    })
    .where(and(eq(contacts.id, contactId), eq(contacts.userId, userId)));

  const open = await db.query.reminders.findMany({
    where: and(
      eq(reminders.userId, userId),
      eq(reminders.contactId, contactId),
      eq(reminders.status, "pending")
    ),
  });
  for (const r of open) {
    await completeReminder(userId, r.id);
  }

  revalidatePath("/dashboard");
  revalidatePath("/contacts");
  revalidatePath(`/contacts/${contactId}`);
  revalidatePath("/graph");
  return { ok: true };
}

export type FollowUpTouchChannel = "email" | "linkedin_message" | "note";

/** Log a touch and clear the due follow-up (used after send / mark sent). */
export async function completeFollowUpWithTouch(
  contactId: string,
  options?: {
    channel?: FollowUpTouchChannel;
    notes?: string;
  }
) {
  const channel = options?.channel ?? "note";
  const { logInteraction } = await import("@/actions/contacts");
  await logInteraction({
    contactId,
    interactionType: channel,
    source: "follow_up",
    rawNotes: options?.notes,
    aiSummary:
      channel === "email"
        ? "Sent follow-up email"
        : channel === "linkedin_message"
          ? "Sent LinkedIn follow-up"
          : "Completed follow-up",
  });
  return clearContactFollowUp(contactId);
}

export async function markReminderDone(id: string) {
  const userId = await requireUserId();
  await completeReminder(userId, id);
  revalidatePath("/");
  revalidatePath("/dashboard");
}

/** Draft a follow-up message grounded in the reminder contact's conversation history. */
export async function draftFollowUpResponse(reminderId: string) {
  const userId = await requireUserId();
  const goals = await listActiveGoalTexts(userId);
  return generateFollowUpDraft(userId, reminderId, goals);
}

export async function snoozeReminderAction(id: string, days = 7) {
  const userId = await requireUserId();
  await snoozeReminder(userId, id, days);
  revalidatePath("/");
  revalidatePath("/dashboard");
  revalidatePath("/contacts");
  revalidatePath("/graph");
}

/** Full inbox for the in-app notifications panel. */
export async function listNotificationPanel() {
  const userId = await requireUserId();
  const db = await getDb();
  const { contacts, aiSuggestions } = await import("@/db/schema");
  const now = new Date();

  const [pendingReminders, contactRows, suggestions] = await Promise.all([
    db.query.reminders.findMany({
      where: and(eq(reminders.userId, userId), eq(reminders.status, "pending")),
      orderBy: (r, { asc }) => [asc(r.dueDate)],
      limit: 80,
    }),
    db.query.contacts.findMany({
      where: eq(contacts.userId, userId),
      columns: {
        id: true,
        fullName: true,
        preferredName: true,
        nextFollowUpAt: true,
        company: true,
        title: true,
      },
      limit: 300,
    }),
    db.query.aiSuggestions.findMany({
      where: and(
        eq(aiSuggestions.userId, userId),
        eq(aiSuggestions.status, "pending")
      ),
      orderBy: (s, { desc }) => [desc(s.confidenceScore)],
      limit: 30,
    }),
  ]);

  type PanelItem = {
    id: string;
    kind: "reminder" | "follow_up" | "suggestion";
    title: string;
    body: string | null;
    url: string;
    dueAt: string | null;
    urgency: "due" | "upcoming" | "info";
    reminderId?: string;
    suggestionId?: string;
    contactId?: string | null;
  };

  const items: PanelItem[] = [];

  for (const r of pendingReminders) {
    const dueAt = r.dueDate ? new Date(r.dueDate) : null;
    const isDue = !dueAt || dueAt <= now;
    items.push({
      id: `reminder:${r.id}`,
      kind: "reminder",
      title: r.title,
      body: r.description,
      url: r.contactId ? `/contacts/${r.contactId}` : "/dashboard",
      dueAt: dueAt?.toISOString() ?? null,
      urgency: isDue ? "due" : "upcoming",
      reminderId: r.id,
      contactId: r.contactId,
    });
  }

  for (const c of contactRows) {
    if (!c.nextFollowUpAt) continue;
    const dueAt = new Date(c.nextFollowUpAt);
    const isDue = dueAt <= now;
    const daysAhead =
      (dueAt.getTime() - now.getTime()) / (1000 * 60 * 60 * 24);
    // Keep due items always; upcoming only within ~2 months to avoid noise.
    if (!isDue && daysAhead > 60) continue;
    const name = c.preferredName || c.fullName;
    items.push({
      id: `followup:${c.id}:${dueAt.toISOString().slice(0, 10)}`,
      kind: "follow_up",
      title: `Follow up with ${name}`,
      body: [c.title, c.company].filter(Boolean).join(" · ") || null,
      url: `/contacts/${c.id}`,
      dueAt: dueAt.toISOString(),
      urgency: isDue ? "due" : "upcoming",
      contactId: c.id,
    });
  }

  for (const s of suggestions) {
    const related = Array.isArray(s.relatedContactIds)
      ? (s.relatedContactIds as string[])
      : [];
    items.push({
      id: `suggestion:${s.id}`,
      kind: "suggestion",
      title: s.title,
      body: s.description,
      url: related[0] ? `/contacts/${related[0]}` : "/dashboard",
      dueAt: null,
      urgency: "info",
      suggestionId: s.id,
      contactId: related[0] ?? null,
    });
  }

  const urgencyRank = { due: 0, upcoming: 1, info: 2 } as const;
  items.sort((a, b) => {
    const ur = urgencyRank[a.urgency] - urgencyRank[b.urgency];
    if (ur !== 0) return ur;
    const aTime = a.dueAt ? new Date(a.dueAt).getTime() : Number.POSITIVE_INFINITY;
    const bTime = b.dueAt ? new Date(b.dueAt).getTime() : Number.POSITIVE_INFINITY;
    return aTime - bTime;
  });

  const dueCount = items.filter((i) => i.urgency === "due").length;

  return { items, dueCount, totalCount: items.length };
}

/** Lightweight payload for browser/desktop notification polling. */
export async function listDueNotificationItems() {
  const panel = await listNotificationPanel();
  return panel.items
    .filter((i) => i.urgency === "due")
    .slice(0, 12)
    .map((i) => ({
      id: i.id,
      title: i.title,
      body: i.body || undefined,
      url: i.url,
    }));
}

export async function dismissSuggestion(id: string) {
  const userId = await requireUserId();
  const db = await getDb();
  const { aiSuggestions } = await import("@/db/schema");
  await db
    .update(aiSuggestions)
    .set({ status: "dismissed" })
    .where(and(eq(aiSuggestions.id, id), eq(aiSuggestions.userId, userId)));
  revalidatePath("/");
  revalidatePath("/dashboard");
}

export async function scheduleFromSuggestion(suggestionId: string, days = 7) {
  const userId = await requireUserId();
  const db = await getDb();
  const { aiSuggestions } = await import("@/db/schema");

  const suggestion = await db.query.aiSuggestions.findFirst({
    where: and(
      eq(aiSuggestions.id, suggestionId),
      eq(aiSuggestions.userId, userId)
    ),
  });
  if (!suggestion) throw new Error("Suggestion not found");

  const contactId = suggestion.relatedContactIds?.[0];
  if (!contactId) throw new Error("No contact linked to this suggestion");

  const result = await scheduleContactFollowUp(contactId, days);
  await dismissSuggestion(suggestionId);
  return result;
}

export async function acceptScoreBump(suggestionId: string) {
  const userId = await requireUserId();
  const db = await getDb();
  const { aiSuggestions, contacts } = await import("@/db/schema");

  const suggestion = await db.query.aiSuggestions.findFirst({
    where: and(
      eq(aiSuggestions.id, suggestionId),
      eq(aiSuggestions.userId, userId)
    ),
  });
  if (!suggestion || suggestion.suggestionType !== "score_bump") {
    throw new Error("Invalid score suggestion");
  }

  const contactId = suggestion.relatedContactIds?.[0];
  if (!contactId) throw new Error("No contact linked to this suggestion");

  const match = suggestion.description?.match(/relationship score (\d+)/i);
  const newScore = match ? Number(match[1]) : NaN;
  if (!Number.isFinite(newScore) || newScore < 1 || newScore > 5) {
    throw new Error("Could not parse suggested score");
  }

  await db
    .update(contacts)
    .set({ relationshipScore: newScore, updatedAt: new Date() })
    .where(and(eq(contacts.id, contactId), eq(contacts.userId, userId)));

  await dismissSuggestion(suggestionId);

  revalidatePath("/contacts");
  revalidatePath(`/contacts/${contactId}`);
  revalidatePath("/graph");
  return { contactId, newScore };
}

/** Generate more due follow-ups from dormant / high-value contacts. */
export async function generateDueFollowUpsAction(limit = 8) {
  const userId = await requireUserId();
  const result = await generateDueFollowUps(userId, limit);
  revalidatePath("/");
  revalidatePath("/dashboard");
  revalidatePath("/contacts");
  revalidatePath("/graph");
  return result;
}
