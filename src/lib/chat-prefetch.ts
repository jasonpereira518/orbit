/**
 * The always-on sections of the chat prompt that are not about contacts: what the user has
 * on their plate (reminders across every view), what they have promised (open action items
 * from notes), and their events.
 *
 * WHY ALWAYS. These used to load only when a question's shape said it needed them — reminders
 * only "due today or overdue", commitments only inside the research step, events never. A
 * question phrased in words the router did not expect ("what's coming up for me?", "what did I
 * say I'd send Omar?", "how many people do I know going to the summit?") reached a model that
 * had none of it, and the honest answer was "I don't know". Each section is a few hundred
 * tokens behind a hard character cap; that is cheaper than one research round.
 *
 * Every section is records some other process wrote — reminder titles drafted from notes,
 * action items a model pulled out of a note, event titles from a public listing — so `ai.ts`
 * fences each one as untrusted, exactly like the contacts.
 *
 * The renderers are pure and exported so `scripts/smoke-chat-prefetch.ts` can pin them; the
 * loaders are the thin database half.
 */
import { and, count, desc, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { actionItems, contacts } from "@/db/schema";
import { sanitizeProfileLine } from "@/lib/contact-profile-format";
import { listEventsForUser, type EventListRow } from "@/lib/events/store";
import { getInboxListId } from "@/lib/reminder-lists";
import type { ReminderRow } from "@/lib/reminders-page";
import { queryRemindersPage } from "@/lib/reminders-page-query";
import { isSurfaceLive } from "@/lib/surface-visibility";

/** Hard caps per section, in characters. A section over its cap loses its last lines. */
export const PREFETCH_CAPS = { reminders: 2000, commitments: 1200, events: 1500 } as const;

/** Reminders listed by id: the allowlist for a reminder proposal is exactly these. */
const REMINDER_ROWS = 12;
const COMMITMENT_ROWS = 8;
const EVENT_ROWS_EACH_WAY = 5;

export type ReminderViewPage = { items: ReminderRow[]; total: number | null };

export type ChatPrefetch = {
  /** The reminders section, unfenced, or null when the user has no open reminders. */
  reminders: string | null;
  /** Every reminder the section lists by id — the proposal allowlist and its titles. */
  reminderRows: ReminderRow[];
  /** Open action items from notes, either direction, unfenced, or null when there are none. */
  commitments: string | null;
  /** Upcoming and recent events, unfenced, or null when there are none or events are closed. */
  events: string | null;
};

export const EMPTY_PREFETCH: ChatPrefetch = {
  reminders: null,
  reminderRows: [],
  commitments: null,
  events: null,
};

/** Drop trailing lines until the text fits, saying how many were left out. */
export function capLines(head: string, lines: string[], cap: number): string {
  const kept = [...lines];
  const render = (dropped: number) =>
    [head, ...kept, ...(dropped ? [`(${dropped} more not shown)`] : [])].join("\n");
  let dropped = 0;
  while (kept.length > 0 && render(dropped).length > cap) {
    kept.pop();
    dropped++;
  }
  return render(dropped);
}

function line(value: string | null | undefined, max: number): string {
  return value ? sanitizeProfileLine(value).slice(0, max) : "";
}

function ymd(value: Date | string | null | undefined): string | null {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

/**
 * Reminders across views: the counts the user would see on /reminders, then the nearest
 * open ones by id — everything overdue or due today first, then what is coming up, then a
 * few with no date.
 */
export function renderReminders(
  pages: { today: ReminderViewPage; upcoming: ReminderViewPage; anytime: ReminderViewPage },
  today: string
): { text: string | null; rows: ReminderRow[] } {
  const totals = {
    today: pages.today.total ?? pages.today.items.length,
    upcoming: pages.upcoming.total ?? pages.upcoming.items.length,
    anytime: pages.anytime.total ?? pages.anytime.items.length,
  };
  if (totals.today + totals.upcoming + totals.anytime === 0) return { text: null, rows: [] };
  const rows = [
    ...pages.today.items.slice(0, 8),
    ...pages.upcoming.items,
    ...pages.anytime.items.slice(0, 3),
  ].slice(0, REMINDER_ROWS);
  const lines = rows.map((r) => {
    const day = r.dueDay ?? ymd(r.dueDate);
    const when = day ? `due ${day}${day < today ? " (overdue)" : day === today ? " (today)" : ""}` : "no date";
    const who = r.contactName ? ` · ${line(r.contactName, 80)}` : "";
    return `- [reminder_id=${r.id}] ${line(r.title, 160)} · ${when}${who}`;
  });
  const head = `Today is ${today}. Overdue or due today: ${totals.today} · coming up: ${totals.upcoming} · no date: ${totals.anytime}. The nearest:`;
  return { text: capLines(head, lines, PREFETCH_CAPS.reminders), rows };
}

export type CommitmentRow = {
  id: string;
  text: string;
  contactId: string;
  contactName: string;
  /** Who owes it, when the note said: the user ("me") or the contact ("them"). */
  owedBy: "me" | "them" | null;
};

/** Open action items taken from notes — what the user promised someone, or was promised. */
export function renderCommitments(rows: CommitmentRow[], total: number): string | null {
  if (!rows.length) return null;
  const lines = rows.map((r) => {
    const name = line(r.contactName, 80);
    const who = r.owedBy === "them" ? `${name} owes the user` : r.owedBy === "me" ? `the user owes ${name}` : `with ${name}`;
    return `- ${line(r.text, 200)} · ${who} [id=${r.contactId}]`;
  });
  return capLines(`${total} open, newest first:`, lines, PREFETCH_CAPS.commitments);
}

function eventLine(e: EventListRow): string {
  const where = [line(e.venue, 60), line(e.city, 40)].filter(Boolean).join(", ");
  const roster = e.attendeeCount
    ? ` · ${e.attendeeCount} on the roster, ${e.connectedCount} of them in your contacts`
    : "";
  return `- [event_id=${e.id}] ${line(e.title, 120) || "Untitled"} · ${ymd(e.startsAt) ?? "no date"}${where ? ` · ${where}` : ""}${e.role === "hosted" ? " · the user hosts it" : ""}${roster}`;
}

/** The user's next and most recent events, with how much of each roster they know. */
export function renderEvents(upcoming: EventListRow[], past: EventListRow[]): string | null {
  if (!upcoming.length && !past.length) return null;
  const lines = [
    ...(upcoming.length ? ["Coming up:", ...upcoming.map(eventLine)] : []),
    ...(past.length ? ["Recently:", ...past.map(eventLine)] : []),
  ];
  return capLines("The user's events (use event_id when one is named):", lines, PREFETCH_CAPS.events);
}

async function loadReminders(userId: string, tz: string, now: Date) {
  const db = await getDb();
  const inboxId = await getInboxListId(userId);
  const page = (view: "today" | "upcoming" | "anytime", limit: number) =>
    queryRemindersPage(db, userId, { view, listId: null, limit, tz }, { inboxId, now });
  const [today, upcoming, anytime] = await Promise.all([
    page("today", 8),
    page("upcoming", REMINDER_ROWS),
    page("anytime", 3),
  ]);
  const todayYmd = today.today;
  return renderReminders({ today, upcoming, anytime }, todayYmd);
}

async function loadCommitments(userId: string) {
  const db = await getDb();
  const open = and(eq(actionItems.userId, userId), eq(actionItems.status, "open"));
  const [rows, [total]] = await Promise.all([
    db
      .select({
        id: actionItems.id,
        text: actionItems.text,
        contactId: actionItems.contactId,
        contactName: contacts.fullName,
        owedBy: actionItems.owedBy,
      })
      .from(actionItems)
      .innerJoin(contacts, eq(contacts.id, actionItems.contactId))
      .where(open)
      .orderBy(desc(actionItems.createdAt))
      .limit(COMMITMENT_ROWS),
    db.select({ n: count() }).from(actionItems).where(open),
  ]);
  return renderCommitments(
    rows.map((r) => ({ ...r, owedBy: r.owedBy ?? null })),
    total?.n ?? rows.length
  );
}

async function loadEvents(userId: string, now: Date) {
  const [upcoming, past] = await Promise.all([
    listEventsForUser(userId, EVENT_ROWS_EACH_WAY, { when: "upcoming", now }),
    listEventsForUser(userId, EVENT_ROWS_EACH_WAY, { when: "past", now }),
  ]);
  if (!upcoming.length && !past.length) return null;
  // An events page that has not shipped for this account is not something chat brings up.
  // Checked only once there is something to show: resolving visibility can read the account
  // row, and most questions come from accounts with no events at all.
  if (!(await isSurfaceLive(userId, "page.events"))) return null;
  return renderEvents(upcoming, past);
}

/**
 * All three sections, side by side. Never fatal: a section whose read fails is simply absent,
 * the same as a section with nothing in it — the answer must not fail over a reminder count.
 */
export async function loadChatPrefetch(
  userId: string,
  options: { tz: string; now?: Date }
): Promise<ChatPrefetch> {
  const now = options.now ?? new Date();
  const [reminders, commitments, events] = await Promise.all([
    loadReminders(userId, options.tz, now).catch(() => ({ text: null, rows: [] as ReminderRow[] })),
    loadCommitments(userId).catch(() => null),
    loadEvents(userId, now).catch(() => null),
  ]);
  return { reminders: reminders.text, reminderRows: reminders.rows, commitments, events };
}
