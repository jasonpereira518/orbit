"use server";

import { and, eq } from "drizzle-orm";
import { after } from "next/server";
import { revalidatePath } from "next/cache";
import { getDb } from "@/db";
import { reminders } from "@/db/schema";
import { requireUserId } from "@/lib/auth";
import {
  completeReminder,
  generateDueFollowUps,
  getDashboardData,
  snoozeReminder,
} from "@/lib/reminders";

export async function fetchDashboard() {
  const userId = await requireUserId();
  // Calendar sync can be slow; don't block the dashboard paint.
  after(() => {
    void import("@/lib/calendar-sync")
      .then(({ syncDueCalendarSubscriptions }) =>
        syncDueCalendarSubscriptions(userId)
      )
      .catch(() => {});
  });
  return getDashboardData(userId);
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

export async function completeContactFollowUp(contactId: string) {
  return clearContactFollowUp(contactId);
}

export async function markReminderDone(id: string) {
  const userId = await requireUserId();
  await completeReminder(userId, id);
  revalidatePath("/");
  revalidatePath("/dashboard");
}

export async function snoozeReminderAction(id: string, days = 7) {
  const userId = await requireUserId();
  await snoozeReminder(userId, id, days);
  revalidatePath("/");
  revalidatePath("/dashboard");
}

/** Lightweight payload for browser/desktop notification polling. */
export async function listDueNotificationItems() {
  const userId = await requireUserId();
  const db = await getDb();
  const { contacts } = await import("@/db/schema");
  const now = new Date();

  const dueReminders = await db.query.reminders.findMany({
    where: and(eq(reminders.userId, userId), eq(reminders.status, "pending")),
    limit: 40,
  });

  const items: { id: string; title: string; body?: string; url: string }[] = [];

  for (const r of dueReminders) {
    if (r.dueDate && new Date(r.dueDate) > now) continue;
    items.push({
      id: `reminder:${r.id}`,
      title: r.title,
      body: r.description || "Follow-up is due in Orbit",
      url: r.contactId ? `/contacts/${r.contactId}` : "/dashboard",
    });
  }

  const dueContacts = await db.query.contacts.findMany({
    where: eq(contacts.userId, userId),
    columns: {
      id: true,
      fullName: true,
      preferredName: true,
      nextFollowUpAt: true,
      company: true,
      title: true,
    },
    limit: 200,
  });

  for (const c of dueContacts) {
    if (!c.nextFollowUpAt || new Date(c.nextFollowUpAt) > now) continue;
    const name = c.preferredName || c.fullName;
    items.push({
      id: `followup:${c.id}:${new Date(c.nextFollowUpAt).toISOString().slice(0, 10)}`,
      title: `Follow up with ${name}`,
      body: [c.title, c.company].filter(Boolean).join(" · ") || "Due follow-up",
      url: `/contacts/${c.id}`,
    });
  }

  return items.slice(0, 12);
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
