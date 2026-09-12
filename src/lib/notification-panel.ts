import { and, eq, isNotNull, lte } from "drizzle-orm";
import { getDb } from "@/db";
import { aiSuggestions, contacts, reminders, suggestedReminders } from "@/db/schema";
import { getEntitlements } from "@/lib/entitlements";
import { getAccountAlerts, hasErrorAlert } from "@/lib/account-health";
import type { AccountAlert } from "@/lib/account-alerts";

/** Upcoming follow-ups are shown this far ahead; further out is noise. */
const UPCOMING_WINDOW_MS = 60 * 24 * 60 * 60 * 1000;

/**
 * Full inbox for the in-app notifications panel, as a plain function of `userId`.
 *
 * Lives here rather than in `src/actions/reminders.ts` so the query-budget smoke test can
 * call it without a Clerk session; the server action is a thin wrapper. `now` is a
 * parameter for the same reason.
 *
 * `withAlerts` exists so the desktop-notification watcher, which polls this every 90
 * seconds — faster than the panel itself — pays nothing for account alerts it discards.
 */
export async function loadNotificationPanel(
  userId: string,
  now: Date,
  opts: { withAlerts: boolean } = { withAlerts: true }
) {
  const db = await getDb();

  const [
    pendingReminders,
    contactRows,
    suggestions,
    datedSuggestions,
    entitlements,
    alerts,
  ] = await Promise.all([
    db.query.reminders.findMany({
      where: and(eq(reminders.userId, userId), eq(reminders.status, "pending")),
      orderBy: (r, { asc: ascOrder }) => [ascOrder(r.dueDate)],
      limit: 80,
    }),
    // Due first, then the next two months, straight off `contacts_follow_up_idx`. This
    // used to take 300 arbitrary rows and filter in JS, which both scanned needlessly and
    // silently dropped due follow-ups for anyone with more than 300 contacts.
    db.query.contacts.findMany({
      where: and(
        eq(contacts.userId, userId),
        isNotNull(contacts.nextFollowUpAt),
        lte(contacts.nextFollowUpAt, new Date(now.getTime() + UPCOMING_WINDOW_MS))
      ),
      columns: {
        id: true,
        fullName: true,
        preferredName: true,
        nextFollowUpAt: true,
        company: true,
        title: true,
      },
      orderBy: (c, { asc: ascOrder }) => [ascOrder(c.nextFollowUpAt)],
      limit: 100,
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
    opts.withAlerts
      ? getAccountAlerts(userId)
      : Promise.resolve<AccountAlert[]>([]),
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
    /**
     * Account health, as a SIBLING of `items` and never an entry in it. That placement is
     * the structural guarantee that alerts can never become OS desktop notifications:
     * `listDueNotificationItems` maps `panel.items` alone, so there is no discipline to
     * forget. `alertDot` never contributes to the bell's numeric badge — a persistent
     * condition like a missing API key would pin the count forever.
     */
    alerts,
    alertDot: hasErrorAlert(alerts),
  };
}

