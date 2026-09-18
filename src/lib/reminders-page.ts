/**
 * Types and constants for the reminders page, kept out of `actions/reminders.ts` because a
 * "use server" file may only export async functions — a plain const there is a build error
 * (same split as `contacts-page.ts`). Safe for client components: no database imports.
 */
import type { ReminderActionKind, ReminderOrigin } from "@/db/schema";

export const REMINDERS_PAGE_SIZE = 50;

/**
 * The rail's smart views. Overdue is part of Today (its own section there) rather than a
 * view of its own, so no reminder is ever counted under two rail entries.
 */
export const REMINDER_VIEWS = ["today", "upcoming", "anytime", "done"] as const;
export type ReminderView = (typeof REMINDER_VIEWS)[number];

export function isReminderView(v: unknown): v is ReminderView {
  return typeof v === "string" && (REMINDER_VIEWS as readonly string[]).includes(v);
}

/**
 * Where a reminder came from, as a filter. Maps onto `reminder_type` (plus `note_batch_id`
 * for notes) in `reminders-page-query.ts`.
 */
export const REMINDER_SOURCES = ["manual", "notes", "ai", "auto"] as const;
export type ReminderSource = (typeof REMINDER_SOURCES)[number];

export const REMINDER_SOURCE_LABELS: Record<ReminderSource, string> = {
  manual: "Added by you",
  notes: "From notes",
  ai: "AI suggested",
  auto: "Auto-generated",
};

export function isReminderSource(v: unknown): v is ReminderSource {
  return typeof v === "string" && (REMINDER_SOURCES as readonly string[]).includes(v);
}

export type RemindersPageFilters = {
  /** A smart view, or null when a list is selected. */
  view: ReminderView | null;
  /** A list id. Wins over `view`. */
  listId: string | null;
  q?: string;
  kinds?: ReminderActionKind[];
  sources?: ReminderSource[];
  contactId?: string | null;
  cursor?: string;
  limit?: number;
  /** The viewer's IANA zone; decides what "today" means. */
  tz: string;
};

export type ReminderRow = {
  id: string;
  title: string;
  description: string | null;
  /** ISO string — crosses the server boundary without Date revival. */
  dueDate: string | null;
  /** The viewer's calendar day for `dueDate` (see `reminder-due-bucket.ts`). */
  dueDay: string | null;
  status: string;
  reminderType: string;
  actionKind: ReminderActionKind;
  origin: ReminderOrigin;
  confidenceScore: number | null;
  listId: string | null;
  contactId: string | null;
  contactName: string | null;
  contactEmail: string | null;
  contactPhone: string | null;
  contactLastTouch: string | null;
  noteBatchId: string | null;
  sourceExcerpt: string | null;
  rawDatePhrase: string | null;
  createdAt: string;
};

export type ReminderRailCounts = {
  today: number;
  overdue: number;
  upcoming: number;
  anytime: number;
  done: number;
  suggested: number;
};

export type ReminderListSummary = {
  id: string;
  name: string;
  isInbox: boolean;
  /** Pending reminders filed in this list. */
  pendingCount: number;
};

export type RemindersPage = {
  items: ReminderRow[];
  nextCursor: string | null;
  /** Total matching the filters. First page only; null when continuing. */
  total: number | null;
  /** The viewer's today, YYYY-MM-DD — the server's answer, so rows bucket the same way. */
  today: string;
  /** The contact filter's display name, so the chip can label a filter loaded from a URL. */
  contactFilter?: { id: string; name: string } | null;
};
