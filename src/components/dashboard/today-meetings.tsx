/**
 * Today's remaining meetings, at the top of the dashboard: the next calendar meeting as a hero (who,
 * when, Join, Prep), the rest as compact rows. Read from `calendar_events`, so no Google round-trip,
 * and from the meetings Orbit keeps itself (a `meet` reminder set at a time — what chat's
 * `create_meeting` makes), marked "in Orbit". The card renders only when there is a meeting.
 */
import Link from "next/link";
import { and, eq, gte, inArray, lt } from "drizzle-orm";
import { cookies } from "next/headers";
import { after } from "next/server";
import { CalendarDays, Sparkles, Video } from "lucide-react";
import { getDb } from "@/db";
import { contacts, reminders, type CalendarEventAttendee } from "@/db/schema";
import { AddAttendeeButton } from "@/components/dashboard/add-attendee-button";
import { ContactAvatar } from "@/components/contacts/contact-avatar";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { requireUserId } from "@/lib/auth";
import { listUpcomingEvents, relinkEvents } from "@/lib/calendar-events";
import { hhmmInZone, userTimeZone } from "@/lib/meeting-context";
import { isDateOnlyDue, isValidTimeZone, TZ_COOKIE, ymdInZone } from "@/lib/reminder-due-bucket";
import { captureRadarTimeZone } from "@/lib/radar/digest";
import { cn } from "@/lib/utils";

type Person = {
  key: string;
  contactId: string | null;
  name: string;
  email: string;
  firstName: string | null;
  role: string | null;
  photo: string | null;
};

const CALL: Record<string, string> = { meet: "Google Meet", zoom: "Zoom", teams: "Teams", webex: "Webex" };

function initials(name: string) {
  // An email stands in for a missing name: its domain is not part of who they are.
  const parts = name.split("@")[0].split(/[\s._-]+/).filter(Boolean);
  return ((parts[0]?.[0] ?? "") + (parts.length > 1 ? parts[parts.length - 1][0] : "")).toUpperCase() || "?";
}

function untilLabel(start: Date, now: Date) {
  const min = Math.round((start.getTime() - now.getTime()) / 60_000);
  if (min <= 0) return "Happening now";
  if (min < 60) return `Next up · in ${min} min`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return `Next up · in ${h} hr${m ? ` ${m} min` : ""}`;
}

function PersonAvatar({ p, size = "sm", className }: { p: Person; size?: "sm" | "default" | "lg"; className?: string }) {
  if (p.contactId) {
    return (
      <ContactAvatar
        contactId={p.contactId}
        firstName={p.firstName}
        fullName={p.name}
        profileImageUrl={p.photo}
        // Every guest has an email, so the avatar route (LinkedIn → Unavatar → Gravatar) has something to try.
        resolveOnDemand
        size={size}
        className={className}
      />
    );
  }
  return (
    <Avatar size={size} className={className} role="img" aria-label={p.name}>
      <AvatarFallback className="bg-primary/10 font-medium text-primary">{initials(p.name)}</AvatarFallback>
    </Avatar>
  );
}

function AvatarStack({ people, max, extra }: { people: Person[]; max: number; extra: number }) {
  const more = Math.max(0, people.length - max) + extra;
  return (
    <span className="flex shrink-0 -space-x-2">
      {people.slice(0, max).map((p) => (
        <PersonAvatar key={p.key} p={p} className="ring-2 ring-card" />
      ))}
      {more > 0 && (
        <span className="relative flex size-6 items-center justify-center rounded-full bg-muted text-[10px] font-medium text-muted-foreground ring-2 ring-card">
          +{more}
        </span>
      )}
    </span>
  );
}

/** Pending `meet` reminders from an hour ago to a day ahead — cut to the local day by the caller. */
async function orbitMeetings(userId: string, now: Date) {
  const db = await getDb();
  return db
    .select({
      id: reminders.id,
      title: reminders.title,
      dueDate: reminders.dueDate,
      calendarEventKey: reminders.calendarEventKey,
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
  // A meeting Orbit also put on the calendar shows once, as the calendar's row.
  const onCalendar = new Set(events.map((e) => e.providerEventId));
  const ours = kept.flatMap(({ dueDate, ...r }) =>
    dueDate && !isDateOnlyDue(dueDate) && ymdInZone(dueDate, tz) <= today && !(r.calendarEventKey && onCalendar.has(r.calendarEventKey))
      ? [{ ...r, dueDate }]
      : []
  );
  if (!shown.length && !ours.length) return null;
  // Someone added since the last sync shows by name.
  const rows = await relinkEvents(userId, shown);

  // The calendar's own guest name is often blank (the email showed instead), so known guests
  // read their name, role and photo from the contact.
  const ids = [...new Set(rows.flatMap((e) => e.attendees.map((a) => a.contactId)).filter((id): id is string => !!id))];
  const found = ids.length
    ? await (await getDb())
        .select({
          id: contacts.id,
          fullName: contacts.fullName,
          firstName: contacts.firstName,
          title: contacts.title,
          company: contacts.company,
          profileImageUrl: contacts.profileImageUrl,
        })
        .from(contacts)
        .where(and(eq(contacts.userId, userId), inArray(contacts.id, ids)))
    : [];
  const byId = new Map(found.map((c) => [c.id, c]));
  const person = (a: CalendarEventAttendee): Person => {
    const c = a.contactId ? byId.get(a.contactId) : undefined;
    return {
      key: c?.id ?? a.email,
      contactId: c?.id ?? null,
      name: c?.fullName || a.name || a.email,
      email: a.email,
      firstName: c?.firstName ?? null,
      role: c ? [c.title, c.company].filter(Boolean).join(" · ") || null : null,
      photo: c?.profileImageUrl ?? null,
    };
  };

  const time = new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", minute: "2-digit" });
  const meetings = rows.map((e) => {
    // Contacts first: the lead and the stack show the people you know.
    const people = e.attendees.map(person).sort((a, b) => Number(!!b.contactId) - Number(!!a.contactId));
    return {
      e,
      people,
      known: people.filter((p) => p.contactId).length,
      // Guests Google counted but did not list (a hidden or truncated guest list).
      hidden: Math.max(0, e.attendeeCount - people.length),
      title: e.title || "Untitled meeting",
      prep: `/chat?q=${encodeURIComponent(`Prep me for my ${hhmmInZone(e.startAt, tz)} meeting, “${e.title}”`)}`,
    };
  });
  const [next, ...rest] = meetings;
  const lead = next?.people[0];
  // Only a web link: an ICS feed can carry any scheme.
  const join = next?.e.conferenceUrl && /^https?:\/\//i.test(next.e.conferenceUrl) ? next.e.conferenceUrl : null;
  const strangers = next ? next.people.filter((p) => !p.contactId && p.email).slice(0, 3) : [];
  const others = next ? next.people.slice(1) : [];
  const total = meetings.length + ours.length;

  const orbitRow = (r: (typeof ours)[number]) => {
    const who = r.contactName || r.contactFullName;
    return (
      <li key={r.id} className="flex items-center gap-3 py-2.5 text-sm">
        <span className="w-14 shrink-0 text-xs tabular-nums text-muted-foreground">{time.format(r.dueDate)}</span>
        {r.contactId && who && (
          <PersonAvatar
            p={{ key: r.contactId, contactId: r.contactId, name: who, email: "", firstName: null, role: null, photo: null }}
          />
        )}
        <span className="min-w-0 flex-1">
          <span className="block truncate font-medium text-ink">
            {r.title}
            <span className="ml-1.5 text-xs font-normal text-muted-foreground">in Orbit</span>
          </span>
          {r.contactId && who && (
            <Link
              href={`/contacts/${r.contactId}`}
              className="block truncate text-xs text-muted-foreground underline-offset-2 hover:underline"
            >
              {who}
            </Link>
          )}
        </span>
        <Link href="/reminders" className={cn(buttonVariants({ variant: "ghost", size: "sm" }), "shrink-0")}>
          Open
        </Link>
      </li>
    );
  };

  const calendarRow = (m: (typeof meetings)[number]) => (
    <li key={m.e.id} className="flex items-center gap-3 py-2.5 text-sm">
      <span className="w-14 shrink-0 text-xs tabular-nums text-muted-foreground">{time.format(m.e.startAt)}</span>
      {m.people.length > 0 && <AvatarStack people={m.people} max={3} extra={m.hidden} />}
      <span className="min-w-0 flex-1">
        <span className="block truncate font-medium text-ink">
          {m.title}
          {m.e.conferenceKind && (
            <Video className="ml-1.5 inline size-3.5 text-muted-foreground" aria-label="Video call" />
          )}
        </span>
        {m.people[0] && (
          <span className="block truncate text-xs text-muted-foreground">
            {m.people[0].name}
            {m.people.length + m.hidden > 1 && ` + ${m.people.length + m.hidden - 1}`}
          </span>
        )}
      </span>
      {m.known > 0 && (
        <Link href={m.prep} className={cn(buttonVariants({ variant: "ghost", size: "sm" }), "shrink-0")}>
          Prep
        </Link>
      )}
    </li>
  );

  // Orbit's own meetings sit in the list beside the calendar's, by time.
  const list = [
    ...ours.map((r) => ({ at: r.dueDate.getTime(), node: orbitRow(r) })),
    ...rest.map((m) => ({ at: m.e.startAt.getTime(), node: calendarRow(m) })),
  ].sort((a, b) => a.at - b.at);

  return (
    <Card className="min-w-0 lg:flex-1 lg:basis-0">
      <CardHeader className="flex items-center gap-2">
        <CalendarDays className="size-4 text-muted-foreground" aria-hidden />
        <CardTitle as="h2" className="text-base">
          Today
        </CardTitle>
        <span className="ml-auto text-xs text-muted-foreground">
          {total} {total === 1 ? "meeting" : "meetings"}
        </span>
      </CardHeader>
      <CardContent className="space-y-3">
        {next && (
          <section aria-label="Next meeting" className="rounded-xl border border-border/60 bg-muted/40 p-4">
            <p className="text-[11px] font-semibold uppercase tracking-wider text-primary">
              {untilLabel(next.e.startAt, now)}
            </p>
            <div className="mt-3 flex items-start gap-3">
              {lead ? (
                <PersonAvatar p={lead} size="lg" className="size-12" />
              ) : (
                <span className="flex size-12 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">
                  <CalendarDays className="size-5" aria-hidden />
                </span>
              )}
              <div className="min-w-0 flex-1">
                {lead?.contactId ? (
                  <Link
                    href={`/contacts/${lead.contactId}`}
                    className="block truncate font-medium text-ink underline-offset-2 hover:underline"
                  >
                    {lead.name}
                  </Link>
                ) : (
                  <p className="truncate font-medium text-ink">{lead ? lead.name : next.title}</p>
                )}
                {lead?.role && <p className="truncate text-xs text-muted-foreground">{lead.role}</p>}
                {lead && <p className="mt-1 truncate text-sm text-ink/80">{next.title}</p>}
                <p className="mt-1 flex items-center gap-1.5 text-xs text-muted-foreground">
                  <span className="tabular-nums">
                    {next.e.endAt ? time.formatRange(next.e.startAt, next.e.endAt) : time.format(next.e.startAt)}
                  </span>
                  {next.e.conferenceKind && (
                    <>
                      <span aria-hidden>·</span>
                      <Video className="size-3.5" aria-hidden />
                      {CALL[next.e.conferenceKind] ?? "Video call"}
                    </>
                  )}
                </p>
              </div>
            </div>

            {(others.length > 0 || next.hidden > 0 || strangers.length > 0) && (
              <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-2">
                {(others.length > 0 || next.hidden > 0) && <AvatarStack people={others} max={4} extra={next.hidden} />}
                {strangers.map((p) => (
                  <span key={p.key} className="flex min-w-0 items-center gap-1 text-xs text-muted-foreground">
                    <span className="max-w-40 truncate">{p.name}</span>
                    <AddAttendeeButton name={p.name === p.email ? "" : p.name} email={p.email} />
                  </span>
                ))}
              </div>
            )}

            {(join || next.known > 0) && (
              <div className="mt-4 flex flex-wrap justify-end gap-2">
                {join && (
                  <a
                    href={join}
                    target="_blank"
                    rel="noopener noreferrer"
                    className={cn(buttonVariants({ variant: "outline", size: "sm" }), "gap-1.5")}
                  >
                    <Video aria-hidden />
                    Join
                  </a>
                )}
                {next.known > 0 && (
                  <Link href={next.prep} className={cn(buttonVariants({ size: "sm" }), "gap-1.5")}>
                    <Sparkles aria-hidden />
                    Prep
                  </Link>
                )}
              </div>
            )}
          </section>
        )}

        {list.length > 0 && <ul className="divide-y divide-border/60">{list.map((m) => m.node)}</ul>}
      </CardContent>
    </Card>
  );
}
