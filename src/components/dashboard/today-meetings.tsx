/**
 * Today's remaining meetings, at the top of the dashboard: when, what, who you know on it, and
 * a "Prep" hand-off to chat. Read from `calendar_events`, so no Google round-trip, and from the
 * meetings Orbit keeps itself (a `meet` reminder set at a time — what chat's `create_meeting`
 * makes), marked "in Orbit". The card renders only when there is a meeting.
 */
import Link from "next/link";
import { and, eq, gte, lt } from "drizzle-orm";
import { cookies } from "next/headers";
import { after } from "next/server";
import { CalendarDays, Video } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { getDb } from "@/db";
import { contacts, reminders } from "@/db/schema";
import { requireUserId } from "@/lib/auth";
import { listUpcomingEvents, relinkEvents } from "@/lib/calendar-events";
import { hhmmInZone, userTimeZone } from "@/lib/meeting-context";
import { isDateOnlyDue, isValidTimeZone, TZ_COOKIE, ymdInZone } from "@/lib/reminder-due-bucket";
import { captureRadarTimeZone } from "@/lib/radar/digest";

/** Pending `meet` reminders from an hour ago to a day ahead — cut to the local day by the caller. */
async function orbitMeetings(userId: string, now: Date) {
  const db = await getDb();
  return db
    .select({
      id: reminders.id,
      title: reminders.title,
      dueDate: reminders.dueDate,
      contactId: reminders.contactId,
      contactName: contacts.preferredName,
      contactFullName: contacts.fullName,
    })
    .from(reminders)
    .leftJoin(contacts, eq(contacts.id, reminders.contactId))
    .where(
      and(
        eq(reminders.userId, userId),
        eq(reminders.status, "pending"),
        eq(reminders.actionKind, "meet"),
        gte(reminders.dueDate, new Date(now.getTime() - 3_600_000)),
        lt(reminders.dueDate, new Date(now.getTime() + 86_400_000))
      )
    )
    .limit(6);
}

export async function TodayMeetingsSection({ now }: { now: Date }) {
  const userId = await requireUserId();
  // This browser's zone first, and remembered: the chat tools and the prep card read the saved
  // one, which until now only Settings and Radar recorded — so "my 3pm" was a UTC 3pm.
  const browserTz = (await cookies()).get(TZ_COOKIE)?.value;
  if (isValidTimeZone(browserTz)) after(() => captureRadarTimeZone(userId, browserTz).catch(() => undefined));
  const [tz, events, kept] = await Promise.all([
    isValidTimeZone(browserTz) ? browserTz : userTimeZone(userId),
    // In progress counts (the read is by overlap); a day at most 24h ahead, cut to the local day below.
    listUpcomingEvents(userId, { from: now, to: new Date(now.getTime() + 86_400_000), limit: 30 }),
    orbitMeetings(userId, now).catch(() => []),
  ]);
  const today = ymdInZone(now, tz);
  const shown = events
    .filter((e) => !e.allDay && e.selfResponse !== "declined" && ymdInZone(e.startAt, tz) <= today)
    .slice(0, 6);
  const ours = kept.flatMap(({ dueDate, ...r }) =>
    dueDate && !isDateOnlyDue(dueDate) && ymdInZone(dueDate, tz) <= today ? [{ ...r, dueDate }] : []
  );
  if (!shown.length && !ours.length) return null;
  // Someone added since the last sync shows by name.
  const rows = await relinkEvents(userId, shown);

  const time = new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", minute: "2-digit" });

  const orbitRow = (r: (typeof ours)[number]) => {
    const who = r.contactName || r.contactFullName;
    return (
      <li key={r.id} className="flex flex-wrap items-baseline gap-x-3 gap-y-1 py-2 text-sm">
        <span className="w-16 shrink-0 font-mono text-xs tabular-nums text-muted-foreground">
          {time.format(r.dueDate)}
        </span>
        <span className="min-w-0 flex-1">
          <span className="font-medium text-ink">{r.title}</span>
          <span className="ml-1.5 text-xs text-muted-foreground">in Orbit</span>
          {r.contactId && who && (
            <span className="block truncate text-xs text-muted-foreground">
              <Link href={`/contacts/${r.contactId}`} className="underline-offset-2 hover:underline">
                {who}
              </Link>
            </span>
          )}
        </span>
        <Link href="/reminders" className="shrink-0 text-xs text-primary underline-offset-2 hover:underline">
          Open
        </Link>
      </li>
    );
  };

  const calendarRow = (e: (typeof rows)[number]) => {
    const known = e.attendees.filter((a) => a.contactId);
    const others = e.attendeeCount - known.length;
    const ask = `/chat?q=${encodeURIComponent(`Prep me for my ${hhmmInZone(e.startAt, tz)} meeting, “${e.title}”`)}`;
    return (
      <li key={e.id} className="flex flex-wrap items-baseline gap-x-3 gap-y-1 py-2 text-sm">
        <span className="w-16 shrink-0 font-mono text-xs tabular-nums text-muted-foreground">
          {time.format(e.startAt)}
        </span>
        <span className="min-w-0 flex-1">
          <span className="font-medium text-ink">{e.title || "Untitled meeting"}</span>
          {e.conferenceKind && (
            <Video className="ml-1.5 inline size-3.5 text-muted-foreground" aria-label="Video call" />
          )}
          {(known.length > 0 || others > 0) && (
            <span className="block truncate text-xs text-muted-foreground">
              {known.map((a, i) => (
                <span key={a.contactId}>
                  {i > 0 && ", "}
                  <Link href={`/contacts/${a.contactId}`} className="underline-offset-2 hover:underline">
                    {a.name || a.email}
                  </Link>
                </span>
              ))}
              {others > 0 && `${known.length ? " + " : ""}${others} ${others === 1 ? "other" : "others"}`}
            </span>
          )}
        </span>
        {known.length > 0 && (
          <Link href={ask} className="shrink-0 text-xs text-primary underline-offset-2 hover:underline">
            Prep
          </Link>
        )}
      </li>
    );
  };

  return (
    <Card>
      <CardHeader className="flex-row items-center gap-2 space-y-0">
        <CalendarDays className="size-4 text-muted-foreground" aria-hidden />
        <CardTitle as="h2" className="text-base">
          Today
        </CardTitle>
      </CardHeader>
      <CardContent>
        <ul className="divide-y divide-border/60">
          {[
            ...ours.map((r) => ({ at: r.dueDate.getTime(), node: orbitRow(r) })),
            ...rows.map((e) => ({ at: e.startAt.getTime(), node: calendarRow(e) })),
          ]
            .sort((a, b) => a.at - b.at)
            .map((m) => m.node)}
        </ul>
      </CardContent>
    </Card>
  );
}
