"use server";

import { and, eq, inArray } from "drizzle-orm";
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
import { requireUserId, getDisplayProfile } from "@/lib/auth";
import { asActionResult, UserFacingError } from "@/lib/errors";
import { generateFollowUpDraft } from "@/lib/follow-up-drafts";
import { loadWritingInstructions } from "@/lib/writing-instructions-store";
import {
  inferReminderActionKind,
  isReminderActionKind,
} from "@/lib/reminder-action-kind";
import { loadNotificationPanel } from "@/lib/notification-panel";
import { traced } from "@/lib/perf-trace";
import {
  revalidatePathIfRequestScoped,
  revalidateReminderPaths,
} from "@/lib/reminder-paths";
import {
  displayListName,
  ensureReminderLists,
  findReminderListForUser,
  getInboxListId,
  normalizeListName,
} from "@/lib/reminder-lists";
import { resolveTimeZone, TZ_COOKIE } from "@/lib/reminder-due-bucket";
import {
  createReminderForUser,
  scheduleContactFollowUpForUser,
} from "@/lib/reminder-writes";
import { isListColor, isListIcon } from "@/lib/reminder-list-style";
import {
  REMINDERS_PAGE_SIZE,
  isReminderSource,
  isReminderView,
  type ReminderListSummary,
  type ReminderRailCounts,
  type RemindersPage,
  type RemindersPageFilters,
} from "@/lib/reminders-page";
import {
  queryReminderRailCounts,
  queryRemindersPage,
} from "@/lib/reminders-page-query";
import {
  completeReminder,
  ensureOutreachSuggestions,
  generateDueFollowUps,
  getDashboardData,
  maybeRefreshOutreachSuggestions,
  dismissReminder,
  reopenReminder,
  restoreDismissedReminder,
  snoozeReminder,
  snoozeReminderTo,
  unsnoozeReminder,
  type CompletionSnapshot,
  type DismissSnapshot,
  type SnoozeSnapshot,
} from "@/lib/reminders";

/*
 * Undo snapshots come back from the client, so they are input like any other. Every
 * inverse is already scoped to the signed-in user and guarded on the row's current
 * state; these checks additionally stop a hand-edited snapshot from writing a status
 * the app never produces.
 */
const REMINDER_STATUSES = new Set(["pending", "done"]);
const FOLLOW_UP_STATUSES = new Set(["none", "pending"]);

function isIsoOrNull(value: unknown): value is string | null {
  return value === null || (typeof value === "string" && !Number.isNaN(Date.parse(value)));
}

function validSnoozeSnapshot(snap: SnoozeSnapshot): boolean {
  return (
    typeof snap?.reminderId === "string" &&
    typeof snap.snoozedTo === "string" &&
    !Number.isNaN(Date.parse(snap.snoozedTo)) &&
    isIsoOrNull(snap.previousDueDate) &&
    REMINDER_STATUSES.has(snap.previousStatus) &&
    (snap.contactId === null || typeof snap.contactId === "string") &&
    isIsoOrNull(snap.previousNextFollowUpAt) &&
    (snap.previousFollowUpStatus === null ||
      FOLLOW_UP_STATUSES.has(snap.previousFollowUpStatus))
  );
}

function validCompletionSnapshot(snap: CompletionSnapshot): boolean {
  return (
    typeof snap?.reminderId === "string" &&
    REMINDER_STATUSES.has(snap.previousStatus) &&
    snap.previousStatus !== "done" &&
    Array.isArray(snap.closedActionItemIds) &&
    snap.closedActionItemIds.length <= 500 &&
    snap.closedActionItemIds.every((id) => typeof id === "string")
  );
}

export async function fetchDashboard() {
  const userId = await requireUserId();
  // One exception to the deferred rebuild below: an account that has never had a queue
  // built has nothing to render, so deferring would show an empty card on the first
  // visit and the real one only on the second. Builds once, then never again.
  //
  // Started alongside the load rather than awaited ahead of it: on every visit but an
  // account's first, this is a one-row existence check that used to add a whole round
  // trip in front of everything else. When it DID build (returns true), the load below
  // raced it and may have read an empty queue, so it is simply run again — once, ever.
  const ensured = ensureOutreachSuggestions(userId).catch(() => false);
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
  const load = () =>
    traced(
      "dashboard.load",
      () =>
        getDashboardData(userId, {
          // Profile read runs concurrently with the DB work; resolved at its single use
          // site (graphPreview.summary.userName).
          userName: getDisplayProfile()
            .then((p) => p?.name || undefined)
            .catch(() => undefined),
        }),
      { userId }
    );

  // No rows donated: getNetworkStats derives its four whole-network figures in SQL now. It
  // used to take the dashboard's scan, which is what forced last_interaction_at and
  // created_at to be selected for the entire account to produce four integers. Started
  // with the load, not after it — the two share nothing, and in sequence the stats query
  // added its full latency to every dashboard render.
  const networkStatsPromise = import("@/lib/network-stats").then(({ getNetworkStats }) =>
    getNetworkStats(userId)
  );

  const [firstLoad, builtQueue, networkStats] = await Promise.all([
    load(),
    ensured,
    networkStatsPromise,
  ]);
  const data = builtQueue ? await load() : firstLoad;

  return { data, networkStats };
}

async function viewerTimeZone() {
  const { cookies } = await import("next/headers");
  try {
    return resolveTimeZone((await cookies()).get(TZ_COOKIE)?.value);
  } catch {
    // No request scope (a script or smoke test calling the action directly): UTC, the same
    // fallback as a request without the cookie.
    return resolveTimeZone(null);
  }
}

/**
 * The reminders rail: lists with their pending counts, and the smart-view counts. Separate
 * from `loadRemindersPage` so paging and filtering never recount the rail.
 */
export async function loadReminderRail(): Promise<{
  lists: ReminderListSummary[];
  inboxId: string | null;
  counts: ReminderRailCounts;
}> {
  const userId = await requireUserId();
  const db = await getDb();
  const [lists, tz] = await Promise.all([
    ensureReminderLists(userId),
    viewerTimeZone(),
  ]);
  const inboxId =
    lists.find((l) => l.isInbox === 1)?.id ?? lists[0]?.id ?? null;
  const { counts, pendingByList } = await queryReminderRailCounts(db, userId, {
    tz,
    inboxId,
  });
  return {
    lists: lists.map((l) => ({
      id: l.id,
      name: l.name,
      isInbox: l.isInbox === 1,
      icon: l.icon ?? null,
      color: l.color ?? null,
      pendingCount: pendingByList.get(l.id) ?? 0,
    })),
    inboxId,
    counts,
  };
}

/**
 * One page of reminders for a view or list, filtered and ordered in Postgres. The first
 * page also carries `total`; pass `cursor` for the next. The viewer's timezone comes from
 * the cookie, never from the caller, so a page and its continuation can't disagree about
 * what "today" is.
 */
export async function loadRemindersPage(
  filters: Omit<RemindersPageFilters, "tz">
): Promise<RemindersPage> {
  const userId = await requireUserId();
  const db = await getDb();
  const [inboxId, tz] = await Promise.all([
    getInboxListId(userId),
    viewerTimeZone(),
  ]);

  let listId: string | null = null;
  if (filters.listId) {
    const list = await findReminderListForUser(userId, filters.listId);
    // A stale or foreign list id shows Today rather than an error page.
    listId = list?.id ?? null;
  }

  const contactId =
    typeof filters.contactId === "string" ? filters.contactId : null;
  const [page, contact] = await Promise.all([
    queryRemindersPage(
      db,
      userId,
      {
        view: listId
          ? null
          : isReminderView(filters.view)
            ? filters.view
            : "today",
        listId,
        q: typeof filters.q === "string" ? filters.q.slice(0, 200) : undefined,
        kinds: filters.kinds?.filter(isReminderActionKind),
        sources: filters.sources?.filter(isReminderSource),
        contactId,
        cursor: typeof filters.cursor === "string" ? filters.cursor : undefined,
        limit: REMINDERS_PAGE_SIZE,
        tz,
      },
      { inboxId }
    ),
    contactId && !filters.cursor
      ? db.query.contacts.findFirst({
          where: and(eq(contacts.id, contactId), eq(contacts.userId, userId)),
          columns: { id: true, fullName: true, preferredName: true },
        })
      : Promise.resolve(undefined),
  ]);
  return {
    ...page,
    contactFilter: contact
      ? {
          id: contact.id,
          name: contact.preferredName?.trim() || contact.fullName,
        }
      : null,
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
  const row = await createReminderForUser(userId, input);
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

/*
 * The three list actions return their validation as data (`asActionResult`) rather than
 * throwing it: a thrown message becomes a digest in production, so "You already have a
 * list with that name" used to arrive as a paragraph about Server Components renders.
 */
export async function createReminderList(name: string) {
  return asActionResult(async () => {
    const userId = await requireUserId();
    const db = await getDb();
    await ensureReminderLists(userId);

    const display = displayListName(name);
    if (!display) throw new UserFacingError("Give the list a name first");
    const normalized = normalizeListName(display);
    if (normalized === "inbox") {
      throw new UserFacingError("You already have an Inbox — pick another name");
    }

    const existing = await db.query.reminderLists.findFirst({
      where: and(
        eq(reminderLists.userId, userId),
        eq(reminderLists.nameNormalized, normalized)
      ),
    });
    if (existing) throw new UserFacingError("You already have a list with that name");

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

    revalidatePathIfRequestScoped("/reminders");
    return row;
  });
}

export async function renameReminderList(id: string, name: string) {
  return asActionResult(async () => {
    const userId = await requireUserId();
    const db = await getDb();

    const list = await findReminderListForUser(userId, id);
    if (!list) throw new Error("List not found");
    if (list.isInbox === 1) throw new UserFacingError("The Inbox can’t be renamed");

    const display = displayListName(name);
    if (!display) throw new UserFacingError("Give the list a name first");
    const normalized = normalizeListName(display);
    if (normalized === "inbox") throw new UserFacingError("Inbox is taken — pick another name");

    const clash = await db.query.reminderLists.findFirst({
      where: and(
        eq(reminderLists.userId, userId),
        eq(reminderLists.nameNormalized, normalized)
      ),
    });
    if (clash && clash.id !== id) {
      throw new UserFacingError("You already have a list with that name");
    }

    const [row] = await db
      .update(reminderLists)
      .set({ name: display, nameNormalized: normalized })
      .where(and(eq(reminderLists.id, id), eq(reminderLists.userId, userId)))
      .returning();

    revalidatePathIfRequestScoped("/reminders");
    return row;
  });
}

/**
 * The list editor's save: any of name, icon and colour. `null` resets icon or colour to the
 * default. The Inbox keeps its name (Jason's call — it's the list Orbit files things into),
 * but can take an icon and colour like any other.
 */
export async function updateReminderList(
  id: string,
  patch: { name?: string; icon?: string | null; color?: string | null }
) {
  return asActionResult(async () => {
    const userId = await requireUserId();
    const db = await getDb();

    const list = await findReminderListForUser(userId, id);
    if (!list) throw new UserFacingError("That list no longer exists");

    const set: Partial<typeof reminderLists.$inferInsert> = {};
    if (patch.name !== undefined) {
      const display = displayListName(patch.name);
      if (!display) throw new UserFacingError("Give the list a name first");
      if (display !== list.name) {
        if (list.isInbox === 1) throw new UserFacingError("The Inbox can’t be renamed");
        const normalized = normalizeListName(display);
        if (normalized === "inbox") throw new UserFacingError("Inbox is taken — pick another name");
        const clash = await db.query.reminderLists.findFirst({
          where: and(
            eq(reminderLists.userId, userId),
            eq(reminderLists.nameNormalized, normalized)
          ),
        });
        if (clash && clash.id !== id) {
          throw new UserFacingError("You already have a list with that name");
        }
        set.name = display;
        set.nameNormalized = normalized;
      }
    }
    if (patch.icon !== undefined) {
      if (patch.icon !== null && !isListIcon(patch.icon)) {
        throw new UserFacingError("That icon isn’t available");
      }
      set.icon = patch.icon;
    }
    if (patch.color !== undefined) {
      if (patch.color !== null && !isListColor(patch.color)) {
        throw new UserFacingError("That color isn’t available");
      }
      set.color = patch.color;
    }
    if (Object.keys(set).length === 0) return list;

    const [row] = await db
      .update(reminderLists)
      .set(set)
      .where(and(eq(reminderLists.id, id), eq(reminderLists.userId, userId)))
      .returning();

    revalidatePathIfRequestScoped("/reminders");
    return row;
  });
}

export async function deleteReminderList(id: string) {
  return asActionResult(async () => {
    const userId = await requireUserId();
    const db = await getDb();

    const list = await findReminderListForUser(userId, id);
    if (!list) throw new Error("List not found");
    if (list.isInbox === 1) throw new UserFacingError("The Inbox can’t be deleted");

    const inboxId = await getInboxListId(userId);
    await db
      .update(reminders)
      .set({ listId: inboxId })
      .where(and(eq(reminders.userId, userId), eq(reminders.listId, id)));

    await db
      .delete(reminderLists)
      .where(and(eq(reminderLists.id, id), eq(reminderLists.userId, userId)));

    revalidatePathIfRequestScoped("/reminders");
    return { inboxId };
  });
}

export async function scheduleContactFollowUp(
  contactId: string,
  days = 7
) {
  const userId = await requireUserId();
  const result = await scheduleContactFollowUpForUser(userId, contactId, days);
  revalidateReminderPaths(contactId);
  revalidatePathIfRequestScoped("/contacts");
  return result;
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
  revalidatePathIfRequestScoped("/contacts");
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
  revalidatePathIfRequestScoped("/contacts");
  // The count is load-bearing, not telemetry: clearing a follow-up also marks every
  // pending reminder for the contact done (and completes their linked action items),
  // which the caller has to be able to say out loud. It used to return a bare
  // `{ ok: true }` and the UI said only "Follow-up cleared".
  return { ok: true, remindersClosed: open.length };
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
    // Orbit only ever logs a follow-up the user sent, so this is always outbound. Set
    // explicitly rather than left NULL: NULL means "sender unknown" and would push the
    // contact onto the legacy volume fallback in constellation eligibility.
    direction: channel === "linkedin_message" ? "out" : undefined,
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
  const snapshot = await completeReminder(userId, id);
  revalidateReminderPaths();
  // Handed back so the toast can offer Undo; see `reopenReminderAction`.
  return snapshot;
}

/** Undo for `markReminderDone`. */
export async function reopenReminderAction(snapshot: CompletionSnapshot) {
  const userId = await requireUserId();
  if (!validCompletionSnapshot(snapshot)) return { restored: false };
  const result = await reopenReminder(userId, snapshot);
  revalidateReminderPaths();
  return result;
}

/**
 * Reopen a done reminder — the Done view's way back. Status only: the action items its
 * completion closed stay closed, because nothing here knows which ones that was (the
 * toast Undo, which does, uses `reopenReminderAction`). Undo is `markReminderDone`.
 */
export async function reopenDoneReminderAction(id: string) {
  const userId = await requireUserId();
  const db = await getDb();
  const rows = await db
    .update(reminders)
    .set({ status: "pending" })
    .where(and(eq(reminders.id, id), eq(reminders.userId, userId), eq(reminders.status, "done")))
    .returning(); // bare: a field selector breaks over the Db union
  revalidateReminderPaths();
  return rows.length > 0 ? { reminderId: id } : null;
}

/** Draft a follow-up message grounded in the reminder contact's conversation history. */
export async function draftFollowUpResponse(reminderId: string) {
  const userId = await requireUserId();
  const goals = await listActiveGoalTexts();
  const writingInstructions = await loadWritingInstructions(userId);
  return generateFollowUpDraft(userId, reminderId, goals, { writingInstructions });
}

export async function snoozeReminderAction(id: string, days = 7) {
  const userId = await requireUserId();
  const snapshot = await snoozeReminder(userId, id, days);
  revalidateReminderPaths();
  revalidatePathIfRequestScoped("/contacts");
  revalidatePathIfRequestScoped("/graph");
  // Handed back so the toast can offer Undo; see `unsnoozeReminderAction`.
  return snapshot;
}

/** Undo for `snoozeReminderAction`. */
export async function unsnoozeReminderAction(snapshot: SnoozeSnapshot) {
  const userId = await requireUserId();
  if (!validSnoozeSnapshot(snapshot)) return { restored: false };
  const result = await unsnoozeReminder(userId, snapshot);
  revalidateReminderPaths();
  revalidatePathIfRequestScoped("/contacts");
  revalidatePathIfRequestScoped("/graph");
  return result;
}

/**
 * A calendar day as the stored due instant: noon UTC, the codebase's "date only" convention
 * (`atLocalNoon` on a UTC server; see `isDateOnly` in calendar-feed.ts). Noon keeps the
 * same calendar day for any viewer within ±11 hours, where UTC midnight is already the
 * previous evening in the Americas.
 */
function dayToDue(ymd: string): Date {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(ymd)) {
    throw new UserFacingError("That date doesn’t look right — pick another?");
  }
  const due = new Date(`${ymd}T12:00:00Z`);
  // Round-trip check: rejects 2026-02-30, which Date would quietly roll into March.
  if (Number.isNaN(due.getTime()) || due.toISOString().slice(0, 10) !== ymd) {
    throw new UserFacingError("That date doesn’t look right — pick another?");
  }
  const fiveYears = 5 * 365 * 86_400_000;
  if (Math.abs(due.getTime() - Date.now()) > fiveYears) {
    throw new UserFacingError("Pick a date within the next few years");
  }
  return due;
}

/** Snooze to a chosen day (the picker's presets and calendar). Undo via `unsnoozeReminderAction`. */
export async function rescheduleReminderAction(id: string, ymd: string) {
  const userId = await requireUserId();
  const snapshot = await snoozeReminderTo(userId, id, dayToDue(ymd));
  revalidateReminderPaths();
  revalidatePathIfRequestScoped("/contacts");
  revalidatePathIfRequestScoped("/graph");
  return snapshot;
}

/** Delete a reminder (soft — see `dismissReminder`). Undo via `restoreReminderAction`. */
export async function deleteReminderAction(id: string) {
  const userId = await requireUserId();
  const snapshot = await dismissReminder(userId, id);
  revalidateReminderPaths();
  return snapshot;
}

function validDismissSnapshot(snap: DismissSnapshot): boolean {
  return (
    typeof snap?.reminderId === "string" &&
    REMINDER_STATUSES.has(snap.previousStatus)
  );
}

/** Undo for `deleteReminderAction`. */
export async function restoreReminderAction(snapshot: DismissSnapshot) {
  const userId = await requireUserId();
  if (!validDismissSnapshot(snapshot)) return { restored: false };
  const result = await restoreDismissedReminder(userId, snapshot);
  revalidateReminderPaths();
  return result;
}

/** Most reminders one bulk action may touch. The page's selection can't exceed a few pages. */
const BULK_LIMIT = 200;
/** Per-row helpers run this many at a time: fast on neon-http, gentle on PGlite. */
const BULK_CONCURRENCY = 6;

async function mapPooled<T, R>(
  items: T[],
  fn: (item: T) => Promise<R>
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(BULK_CONCURRENCY, items.length) }, worker)
  );
  return out;
}

export type BulkReminderOp =
  | { op: "done" }
  | { op: "snooze"; ymd: string }
  | { op: "delete" }
  | { op: "move"; listId: string };

export type BulkReminderSnapshot =
  | { op: "done"; items: CompletionSnapshot[] }
  | { op: "snooze"; items: SnoozeSnapshot[] }
  | { op: "delete"; items: DismissSnapshot[] }
  | {
      op: "move";
      items: Array<{ reminderId: string; previousListId: string | null }>;
    };

/**
 * Done / snooze / delete / move for a selection, with one snapshot so one Undo reverses the
 * lot. Done, snooze and delete go through the same per-row helpers as the single actions —
 * each carries side effects (linked action items, the contact's follow-up clock) and an Undo
 * guard that a set-based rewrite would have to duplicate. Move has no side effects, so it is
 * one statement.
 */
export async function bulkReminderAction(
  ids: string[],
  action: BulkReminderOp
) {
  return asActionResult(async () => {
    const userId = await requireUserId();
    const unique = [...new Set(ids.filter((id) => typeof id === "string"))];
    if (unique.length === 0)
      throw new UserFacingError("Select a reminder first");
    if (unique.length > BULK_LIMIT) {
      throw new UserFacingError(
        `That’s more than ${BULK_LIMIT} at once — select fewer?`
      );
    }

    let snapshot: BulkReminderSnapshot;
    switch (action.op) {
      case "done": {
        const items = await mapPooled(unique, (id) =>
          completeReminder(userId, id)
        );
        snapshot = {
          op: "done",
          items: items.filter((x): x is CompletionSnapshot => Boolean(x)),
        };
        break;
      }
      case "snooze": {
        const due = dayToDue(action.ymd);
        const items = await mapPooled(unique, (id) =>
          snoozeReminderTo(userId, id, due)
        );
        snapshot = {
          op: "snooze",
          items: items.filter((x): x is SnoozeSnapshot => Boolean(x)),
        };
        break;
      }
      case "delete": {
        const items = await mapPooled(unique, (id) =>
          dismissReminder(userId, id)
        );
        snapshot = {
          op: "delete",
          items: items.filter((x): x is DismissSnapshot => Boolean(x)),
        };
        break;
      }
      case "move": {
        const list = await findReminderListForUser(userId, action.listId);
        if (!list) throw new UserFacingError("That list no longer exists");
        const db = await getDb();
        const before = await db
          .select({ id: reminders.id, listId: reminders.listId })
          .from(reminders)
          .where(
            and(eq(reminders.userId, userId), inArray(reminders.id, unique))
          );
        await db
          .update(reminders)
          .set({ listId: list.id })
          .where(
            and(eq(reminders.userId, userId), inArray(reminders.id, unique))
          );
        snapshot = {
          op: "move",
          items: before.map((r) => ({
            reminderId: r.id,
            previousListId: r.listId,
          })),
        };
        break;
      }
      default:
        throw new UserFacingError("That action isn’t available");
    }

    revalidateReminderPaths();
    revalidatePathIfRequestScoped("/contacts");
    revalidatePathIfRequestScoped("/graph");
    return { count: snapshot.items.length, snapshot };
  });
}

/** Undo for `bulkReminderAction`: each row's own inverse, with its own staleness guard. */
export async function undoBulkReminderAction(snapshot: BulkReminderSnapshot) {
  const userId = await requireUserId();
  if (
    !snapshot ||
    !Array.isArray(snapshot.items) ||
    snapshot.items.length > BULK_LIMIT
  ) {
    return { restored: false };
  }

  let restored = 0;
  switch (snapshot.op) {
    case "done": {
      const valid = snapshot.items.filter(validCompletionSnapshot);
      const results = await mapPooled(valid, (snap) =>
        reopenReminder(userId, snap)
      );
      restored = results.filter((r) => r.restored).length;
      break;
    }
    case "snooze": {
      const valid = snapshot.items.filter(validSnoozeSnapshot);
      const results = await mapPooled(valid, (snap) =>
        unsnoozeReminder(userId, snap)
      );
      restored = results.filter((r) => r.restored).length;
      break;
    }
    case "delete": {
      const valid = snapshot.items.filter(validDismissSnapshot);
      const results = await mapPooled(valid, (snap) =>
        restoreDismissedReminder(userId, snap)
      );
      restored = results.filter((r) => r.restored).length;
      break;
    }
    case "move": {
      const db = await getDb();
      const byList = new Map<string | null, string[]>();
      for (const item of snapshot.items) {
        if (typeof item?.reminderId !== "string") continue;
        const key =
          typeof item.previousListId === "string" ? item.previousListId : null;
        byList.set(key, [...(byList.get(key) ?? []), item.reminderId]);
      }
      for (const [listId, ids] of byList) {
        // A list deleted since the move can't be restored to; those rows stay put.
        if (listId && !(await findReminderListForUser(userId, listId)))
          continue;
        const rows = await db
          .update(reminders)
          .set({ listId })
          .where(and(eq(reminders.userId, userId), inArray(reminders.id, ids)))
          .returning(); // bare: a field selector breaks over the Db union
        restored += rows.length;
      }
      break;
    }
  }

  revalidateReminderPaths();
  revalidatePathIfRequestScoped("/contacts");
  revalidatePathIfRequestScoped("/graph");
  return { restored: restored > 0 };
}

/** Full inbox for the in-app notifications panel. */
export async function listNotificationPanel() {
  const userId = await requireUserId();
  const { isAdminUser } = await import("@/lib/admin");
  const { isViewingAsUser } = await import("@/lib/surface-visibility");

  const panel = await loadNotificationPanel(userId, new Date(), {
    withAlerts: true,
  });

  return {
    ...panel,
    /**
     * Whether to offer the operator console in the panel footer.
     *
     * Resolved here because `isAdminUser` reads `ADMIN_USER_IDS`, which is deliberately not
     * a `NEXT_PUBLIC_*` variable — shipping the allowlist to every browser is exactly what
     * that comment in `lib/admin.ts` forbids. A boolean is all the client needs.
     *
     * False while an operator is previewing as an ordinary user: the point of that mode is
     * to see what a user sees, and the view-as banner already carries its own Exit. Note
     * this only decides whether a LINK is drawn — `/admin` does its own checking, since a
     * hidden link is not access control.
     */
    canOpenAdmin: isAdminUser(userId) && !(await isViewingAsUser(userId)),
  };
}

/** Lightweight payload for browser/desktop notification polling. */
export async function listDueNotificationItems() {
  const { getDesktopNotifiedIds } = await import("@/actions/notifications");
  const userId = await requireUserId();
  const [notifiedIds, panel] = await Promise.all([
    getDesktopNotifiedIds(),
    loadNotificationPanel(userId, new Date(), { withAlerts: false }),
  ]);
  const notified = new Set(notifiedIds);

  // `panel.items` only — account alerts live beside it and must never fire an OS
  // notification, for the same reason `suggested_reminder` is pinned to "info" above.
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
  revalidatePathIfRequestScoped("/");
  revalidatePathIfRequestScoped("/dashboard");
}

/**
 * Undo for `dismissSuggestion`. Restores to "pending" without being told what the prior
 * status was, because it can only ever have been pending: every surface that offers a
 * dismiss (the notifications panel, the dashboard, chat attention) lists only pending
 * suggestions. Only touches a row that is still dismissed.
 */
export async function restoreSuggestion(id: string) {
  const userId = await requireUserId();
  const db = await getDb();
  const { aiSuggestions } = await import("@/db/schema");
  const restored = await db
    .update(aiSuggestions)
    .set({ status: "pending" })
    .where(
      and(
        eq(aiSuggestions.id, id),
        eq(aiSuggestions.userId, userId),
        eq(aiSuggestions.status, "dismissed")
      )
    )
    .returning();
  revalidatePathIfRequestScoped("/");
  revalidatePathIfRequestScoped("/dashboard");
  return { restored: restored.length > 0 };
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

  revalidatePathIfRequestScoped("/contacts");
  revalidatePath(`/contacts/${contactId}`);
  revalidatePath("/graph");
  return { contactId, newScore };
}

/** Generate more due follow-ups from dormant / high-value contacts. */
export async function generateDueFollowUpsAction(limit = 8) {
  const userId = await requireUserId();
  const result = await generateDueFollowUps(userId, limit);
  revalidateReminderPaths();
  revalidatePathIfRequestScoped("/contacts");
  revalidatePath("/graph");
  return result;
}
