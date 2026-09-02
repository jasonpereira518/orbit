"use server";

import { and, asc, desc, eq, inArray } from "drizzle-orm";
import { after } from "next/server";
import { revalidatePath } from "next/cache";
import { getDb } from "@/db";
import {
  contacts,
  reminderLists,
  reminders,
  type ReminderActionKind,
} from "@/db/schema";
import { listActiveGoalTexts } from "@/actions/goals";
import { requireUserId, getCurrentUserProfile } from "@/lib/auth";
import { generateFollowUpDraft } from "@/lib/follow-up-drafts";
import {
  inferReminderActionKind,
  isReminderActionKind,
} from "@/lib/reminder-action-kind";
import { revalidateReminderPaths } from "@/lib/reminder-paths";
import {
  displayListName,
  ensureReminderLists,
  findReminderListForUser,
  getInboxListId,
  normalizeListName,
} from "@/lib/reminder-lists";
import {
  completeReminder,
  generateDueFollowUps,
  getDashboardData,
  maybeRefreshOutreachSuggestions,
  snoozeReminder,
} from "@/lib/reminders";

export async function fetchDashboard() {
  const userId = await requireUserId();
  // Calendar sync and the suggestion rebuild are slow; run both after the
  // response instead of on the dashboard's critical path. Suggestions are
  // stale-while-revalidate: this load renders whatever exists, the next
  // load sees the refresh (30-min TTL inside maybeRefresh…).
  after(() => {
    void maybeRefreshOutreachSuggestions(userId).catch(() => {});
    void import("@/lib/calendar-sync")
      .then(({ syncDueCalendarSubscriptions }) =>
        syncDueCalendarSubscriptions(userId)
      )
      .catch(() => {});
  });
  const data = await getDashboardData(userId, {
    // Clerk profile fetch runs concurrently with the DB work; resolved at
    // its single use site (graphPreview.summary.userName).
    userName: getCurrentUserProfile()
      .then((p) => p?.name || undefined)
      .catch(() => undefined),
  });

  // Reuse the contact rows already loaded for the dashboard instead of a
  // second full-network scan for NetworkStatsCard.
  const { getNetworkStats } = await import("@/lib/network-stats");
  const contactRows = [...data.contactById.values()];
  const networkStats = await getNetworkStats(userId, {
    contacts: contactRows.map((c) => ({
      id: c.id,
      relationshipScore: c.relationshipScore,
      lastInteractionAt: c.lastInteractionAt,
      createdAt: c.createdAt,
      company: c.company,
      title: c.title,
      industry: c.industry,
      howMet: c.howMet,
      notes: c.notes,
      aiSummary: c.aiSummary,
      keyFacts: c.keyFacts,
      sharedInterests: c.sharedInterests,
      nextFollowUpAt: c.nextFollowUpAt,
      contactTags:
        (
          c as {
            contactTags?: Array<{ tag: { name: string } }>;
          }
        ).contactTags ??
        (Array.isArray((c as { tags?: string[] }).tags)
          ? ((c as { tags?: string[] }).tags || []).map((name) => ({
              tag: { name },
            }))
          : []),
    })),
  });

  return { data, networkStats };
}

export async function listRemindersPage(options?: {
  listId?: string | null;
  status?: "pending" | "done" | "all";
}) {
  const userId = await requireUserId();
  const db = await getDb();
  const status = options?.status ?? "pending";

  const lists = await ensureReminderLists(userId);
  const inboxId = lists.find((l) => l.isInbox === 1)?.id ?? lists[0]?.id;
  const selectedListId = options?.listId || inboxId || null;
  const selectedIsInbox = Boolean(
    selectedListId && lists.some((l) => l.id === selectedListId && l.isInbox === 1)
  );

  const allReminders = await db.query.reminders.findMany({
    where: eq(reminders.userId, userId),
    orderBy: [asc(reminders.dueDate), desc(reminders.createdAt)],
    limit: 500,
  });

  const contactIds = [
    ...new Set(
      allReminders
        .map((r) => r.contactId)
        .filter((id): id is string => Boolean(id))
    ),
  ];

  const contactRows =
    contactIds.length > 0
      ? await db.query.contacts.findMany({
          where: and(
            eq(contacts.userId, userId),
            inArray(contacts.id, contactIds)
          ),
          columns: {
            id: true,
            fullName: true,
            preferredName: true,
            email: true,
            phone: true,
          },
        })
      : [];

  const contactById = new Map(contactRows.map((c) => [c.id, c] as const));

  const listCounts = new Map<string, { pending: number; done: number }>();
  for (const list of lists) {
    listCounts.set(list.id, { pending: 0, done: 0 });
  }

  const totals = { pending: 0, done: 0 };
  for (const r of allReminders) {
    // Dismissed rows (killed by a note-batch undo) count toward neither bucket — they
    // aren't open work and aren't a completed task, so folding them into "done" would
    // inflate that badge with reminders the done filter itself doesn't return.
    if (r.status === "dismissed") continue;
    const isPending = r.status === "pending";
    if (isPending) totals.pending += 1;
    else totals.done += 1;

    const lid = r.listId || inboxId;
    if (!lid) continue;
    const bucket = listCounts.get(lid) ?? { pending: 0, done: 0 };
    if (isPending) bucket.pending += 1;
    else bucket.done += 1;
    listCounts.set(lid, bucket);
  }

  // Inbox aggregates every list; other lists only show their own reminders.
  const filtered = allReminders.filter((r) => {
    if (!selectedIsInbox) {
      const lid = r.listId || inboxId;
      if (selectedListId && lid !== selectedListId) return false;
    }
    if (status === "pending") return r.status === "pending";
    if (status === "done") {
      return r.status === "done" || r.status === "completed";
    }
    // "all" still excludes dismissed rows: those are reminders an undone note batch
    // killed, not a state the reminders page should ever surface as a list item.
    return r.status !== "dismissed";
  });

  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);
  const endOfToday = new Date(startOfToday);
  endOfToday.setDate(endOfToday.getDate() + 1);

  filtered.sort((a, b) => {
    const aDue = a.dueDate ? new Date(a.dueDate) : null;
    const bDue = b.dueDate ? new Date(b.dueDate) : null;
    const aOverdue = aDue && aDue.getTime() < startOfToday.getTime();
    const bOverdue = bDue && bDue.getTime() < startOfToday.getTime();
    if (aOverdue && !bOverdue) return -1;
    if (!aOverdue && bOverdue) return 1;
    const aToday =
      aDue &&
      aDue.getTime() >= startOfToday.getTime() &&
      aDue.getTime() < endOfToday.getTime();
    const bToday =
      bDue &&
      bDue.getTime() >= startOfToday.getTime() &&
      bDue.getTime() < endOfToday.getTime();
    if (aToday && !bToday && !bOverdue) return -1;
    if (bToday && !aToday && !aOverdue) return 1;
    if (!aDue && bDue) return 1;
    if (aDue && !bDue) return -1;
    if (aDue && bDue) return aDue.getTime() - bDue.getTime();
    return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
  });

  return {
    lists: lists.map((l) => ({
      id: l.id,
      name: l.name,
      isInbox: l.isInbox === 1,
      position: l.position,
      // Inbox count = all reminders; other lists keep their own.
      pendingCount:
        l.isInbox === 1 ? totals.pending : listCounts.get(l.id)?.pending ?? 0,
      doneCount:
        l.isInbox === 1 ? totals.done : listCounts.get(l.id)?.done ?? 0,
    })),
    selectedListId,
    status,
    reminders: filtered.map((r) => {
      const c = r.contactId ? contactById.get(r.contactId) : null;
      return {
        id: r.id,
        title: r.title,
        description: r.description,
        dueDate: r.dueDate,
        status: r.status,
        reminderType: r.reminderType,
        actionKind: (r.actionKind || "task") as ReminderActionKind,
        listId: r.listId || inboxId || null,
        contactId: r.contactId,
        contactName: c ? c.preferredName?.trim() || c.fullName : null,
        contactEmail: c?.email ?? null,
        contactPhone: c?.phone ?? null,
        createdAt: r.createdAt,
      };
    }),
  };
}

export async function createReminder(input: {
  contactId?: string;
  title: string;
  description?: string;
  dueDate?: string;
  reminderType?: string;
  listId?: string;
  actionKind?: ReminderActionKind;
}) {
  const userId = await requireUserId();
  const db = await getDb();
  const inboxId = await getInboxListId(userId);

  let listId = input.listId || inboxId;
  if (input.listId) {
    const list = await findReminderListForUser(userId, input.listId);
    if (!list) throw new Error("List not found");
    listId = list.id;
  }

  const actionKind =
    input.actionKind && isReminderActionKind(input.actionKind)
      ? input.actionKind
      : inferReminderActionKind({
          title: input.title,
          description: input.description,
          reminderType: input.reminderType,
          contactId: input.contactId,
        });

  const [row] = await db
    .insert(reminders)
    .values({
      userId,
      contactId: input.contactId,
      listId,
      title: input.title,
      description: input.description,
      dueDate: input.dueDate ? new Date(input.dueDate) : null,
      reminderType: input.reminderType || "manual",
      actionKind,
      createdBy: "user",
      status: "pending",
    })
    .returning();

  revalidateReminderPaths(input.contactId);
  return row;
}

export async function updateReminder(
  id: string,
  input: {
    title?: string;
    description?: string | null;
    dueDate?: string | null;
    listId?: string | null;
    actionKind?: ReminderActionKind;
    contactId?: string | null;
  }
) {
  const userId = await requireUserId();
  const db = await getDb();

  const existing = await db.query.reminders.findFirst({
    where: and(eq(reminders.id, id), eq(reminders.userId, userId)),
  });
  if (!existing) throw new Error("Reminder not found");

  const patch: Partial<typeof reminders.$inferInsert> = {};

  if (input.title !== undefined) patch.title = input.title.trim();
  if (input.description !== undefined) patch.description = input.description;
  if (input.dueDate !== undefined) {
    patch.dueDate = input.dueDate ? new Date(input.dueDate) : null;
  }
  if (input.contactId !== undefined) patch.contactId = input.contactId;
  if (input.listId !== undefined) {
    if (input.listId) {
      const list = await findReminderListForUser(userId, input.listId);
      if (!list) throw new Error("List not found");
      patch.listId = list.id;
    } else {
      patch.listId = await getInboxListId(userId);
    }
  }
  if (input.actionKind !== undefined) {
    if (!isReminderActionKind(input.actionKind)) {
      throw new Error("Invalid action kind");
    }
    patch.actionKind = input.actionKind;
  } else if (input.title !== undefined) {
    patch.actionKind = inferReminderActionKind({
      title: input.title,
      description:
        input.description !== undefined
          ? input.description
          : existing.description,
      reminderType: existing.reminderType,
      contactId:
        input.contactId !== undefined ? input.contactId : existing.contactId,
    });
  }

  const [row] = await db
    .update(reminders)
    .set(patch)
    .where(and(eq(reminders.id, id), eq(reminders.userId, userId)))
    .returning();

  revalidateReminderPaths(row.contactId ?? existing.contactId);
  return row;
}

export async function moveReminderToList(id: string, listId: string) {
  return updateReminder(id, { listId });
}

export async function createReminderList(name: string) {
  const userId = await requireUserId();
  const db = await getDb();
  await ensureReminderLists(userId);

  const display = displayListName(name);
  if (!display) throw new Error("List name is required");
  const normalized = normalizeListName(display);
  if (normalized === "inbox") {
    throw new Error("Inbox already exists");
  }

  const existing = await db.query.reminderLists.findFirst({
    where: and(
      eq(reminderLists.userId, userId),
      eq(reminderLists.nameNormalized, normalized)
    ),
  });
  if (existing) throw new Error("A list with that name already exists");

  const maxPos = await db.query.reminderLists.findMany({
    where: eq(reminderLists.userId, userId),
    columns: { position: true },
  });
  const nextPos = maxPos.reduce((m, l) => Math.max(m, l.position), 0) + 1;

  const [row] = await db
    .insert(reminderLists)
    .values({
      userId,
      name: display,
      nameNormalized: normalized,
      position: nextPos,
      isInbox: 0,
    })
    .returning();

  revalidatePath("/reminders");
  return row;
}

export async function renameReminderList(id: string, name: string) {
  const userId = await requireUserId();
  const db = await getDb();

  const list = await findReminderListForUser(userId, id);
  if (!list) throw new Error("List not found");
  if (list.isInbox === 1) throw new Error("Cannot rename Inbox");

  const display = displayListName(name);
  if (!display) throw new Error("List name is required");
  const normalized = normalizeListName(display);
  if (normalized === "inbox") throw new Error("Cannot rename to Inbox");

  const clash = await db.query.reminderLists.findFirst({
    where: and(
      eq(reminderLists.userId, userId),
      eq(reminderLists.nameNormalized, normalized)
    ),
  });
  if (clash && clash.id !== id) {
    throw new Error("A list with that name already exists");
  }

  const [row] = await db
    .update(reminderLists)
    .set({ name: display, nameNormalized: normalized })
    .where(and(eq(reminderLists.id, id), eq(reminderLists.userId, userId)))
    .returning();

  revalidatePath("/reminders");
  return row;
}

export async function deleteReminderList(id: string) {
  const userId = await requireUserId();
  const db = await getDb();

  const list = await findReminderListForUser(userId, id);
  if (!list) throw new Error("List not found");
  if (list.isInbox === 1) throw new Error("Cannot delete Inbox");

  const inboxId = await getInboxListId(userId);
  await db
    .update(reminders)
    .set({ listId: inboxId })
    .where(and(eq(reminders.userId, userId), eq(reminders.listId, id)));

  await db
    .delete(reminderLists)
    .where(and(eq(reminderLists.id, id), eq(reminderLists.userId, userId)));

  revalidatePath("/reminders");
  return { ok: true, inboxId };
}

export async function scheduleContactFollowUp(
  contactId: string,
  days = 7
) {
  const userId = await requireUserId();
  const db = await getDb();
  const inboxId = await getInboxListId(userId);

  const contact = await db.query.contacts.findFirst({
    where: and(eq(contacts.id, contactId), eq(contacts.userId, userId)),
    columns: { id: true, fullName: true, preferredName: true },
  });
  if (!contact) throw new Error("Contact not found");

  const due = new Date();
  due.setDate(due.getDate() + Math.max(1, Math.min(90, days)));
  const name = contact.preferredName || contact.fullName;
  const title = `Follow up with ${name}`;
  const actionKind = inferReminderActionKind({
    title,
    reminderType: "manual",
    contactId,
  });

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
        actionKind,
        listId: existing.listId || inboxId,
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
        listId: inboxId,
        title,
        dueDate: due,
        reminderType: "manual",
        actionKind,
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

  revalidateReminderPaths(contactId);
  revalidatePath("/contacts");
  return { reminder: row, dueDate: due.toISOString(), days };
}

/** Schedule a follow-up reminder for an absolute calendar date (local YYYY-MM-DD). */
export async function scheduleContactFollowUpAt(
  contactId: string,
  dateIso: string
) {
  const userId = await requireUserId();
  const db = await getDb();
  const inboxId = await getInboxListId(userId);

  const contact = await db.query.contacts.findFirst({
    where: and(eq(contacts.id, contactId), eq(contacts.userId, userId)),
    columns: { id: true, fullName: true, preferredName: true },
  });
  if (!contact) throw new Error("Contact not found");

  const due = new Date(`${dateIso}T12:00:00`);
  if (Number.isNaN(due.getTime())) throw new Error("Invalid date");

  const name = contact.preferredName || contact.fullName;
  const title = `Follow up with ${name}`;
  const actionKind = inferReminderActionKind({
    title,
    reminderType: "manual",
    contactId,
  });

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
        actionKind,
        listId: existing.listId || inboxId,
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
        listId: inboxId,
        title,
        dueDate: due,
        reminderType: "manual",
        actionKind,
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

  revalidateReminderPaths(contactId);
  revalidatePath("/contacts");
  return { reminder: row, dueDate: due.toISOString() };
}

export async function clearContactFollowUp(contactId: string) {
  const userId = await requireUserId();
  const db = await getDb();

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

  revalidateReminderPaths(contactId);
  revalidatePath("/contacts");
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
  revalidateReminderPaths();
}

/** Draft a follow-up message grounded in the reminder contact's conversation history. */
export async function draftFollowUpResponse(reminderId: string) {
  const userId = await requireUserId();
  const goals = await listActiveGoalTexts();
  return generateFollowUpDraft(userId, reminderId, goals);
}

export async function snoozeReminderAction(id: string, days = 7) {
  const userId = await requireUserId();
  await snoozeReminder(userId, id, days);
  revalidateReminderPaths();
  revalidatePath("/contacts");
  revalidatePath("/graph");
}

/** Full inbox for the in-app notifications panel. */
export async function listNotificationPanel() {
  const userId = await requireUserId();
  const db = await getDb();
  const { aiSuggestions, suggestedReminders } = await import("@/db/schema");
  const { getEntitlements } = await import("@/lib/entitlements");
  const now = new Date();

  const [
    pendingReminders,
    contactRows,
    suggestions,
    datedSuggestions,
    entitlements,
  ] = await Promise.all([
    db.query.reminders.findMany({
      where: and(eq(reminders.userId, userId), eq(reminders.status, "pending")),
      orderBy: (r, { asc: ascOrder }) => [ascOrder(r.dueDate)],
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
      orderBy: (s, { desc: descOrder }) => [descOrder(s.confidenceScore)],
      limit: 30,
    }),
    db.query.suggestedReminders.findMany({
      where: and(
        eq(suggestedReminders.userId, userId),
        eq(suggestedReminders.status, "pending")
      ),
      orderBy: (s, { asc: ascOrder }) => [ascOrder(s.dueDate)],
      limit: 25,
    }),
    getEntitlements(userId),
  ]);

  type PanelItem = {
    id: string;
    kind: "reminder" | "follow_up" | "suggestion" | "suggested_reminder";
    title: string;
    body: string | null;
    url: string;
    dueAt: string | null;
    urgency: "due" | "upcoming" | "info";
    reminderId?: string;
    suggestionId?: string;
    suggestedReminderId?: string;
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
      url: r.contactId ? `/contacts/${r.contactId}` : "/reminders",
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

  for (const s of datedSuggestions) {
    const due = new Date(s.dueDate);
    // Deliberately "info", never "due", even once the date arrives. `dueCount` drives
    // the bell badge and listDueNotificationItems fires OS desktop notifications off
    // urgency === "due" — an unconfirmed AI guess must never reach either. The date is
    // carried in the body text instead.
    items.push({
      id: `suggested_reminder:${s.id}`,
      kind: "suggested_reminder",
      title: s.title,
      body: `${due.toLocaleDateString(undefined, {
        month: "short",
        day: "numeric",
        year: "numeric",
      })} · from your notes`,
      url: "/reminders",
      dueAt: due.toISOString(),
      urgency: "info",
      suggestedReminderId: s.id,
      contactId: s.contactId,
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

  return {
    items,
    dueCount,
    totalCount: items.length,
    // Drives the extension promo in the panel: paid plans get an install link,
    // everyone else gets the pitch and a route to the plans page.
    canUseExtension: entitlements.canUseExtension,
  };
}

/** Lightweight payload for browser/desktop notification polling. */
export async function listDueNotificationItems() {
  const { getDesktopNotifiedIds } = await import("@/actions/notifications");
  const [notifiedIds, panel] = await Promise.all([
    getDesktopNotifiedIds(),
    listNotificationPanel(),
  ]);
  const notified = new Set(notifiedIds);

  return panel.items
    .filter((i) => i.urgency === "due" && !notified.has(i.id))
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
  const { aiSuggestions } = await import("@/db/schema");

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

  // Accepting a suggested score bump is a genuine user rating, same as moving
  // the slider on the contact form — mirror into statedCloseness so this
  // write agrees with contact-writes.ts's updateContactForUser.
  await db
    .update(contacts)
    .set({
      relationshipScore: newScore,
      statedCloseness: newScore,
      updatedAt: new Date(),
    })
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
  revalidateReminderPaths();
  revalidatePath("/contacts");
  revalidatePath("/graph");
  return result;
}
