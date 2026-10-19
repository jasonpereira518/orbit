/**
 * Today's remaining meetings, at the top of the dashboard: when, what, who you know on it, and
 * a "Prep" hand-off to chat. Read from `calendar_events`, so no Google round-trip and nothing
 * at all for someone with no calendar connected — the card renders only when there is a meeting.
 */
import Link from "next/link";
import { cookies } from "next/headers";
import { after } from "next/server";
import { CalendarDays, Video } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { requireUserId } from "@/lib/auth";
import { listUpcomingEvents, relinkEvents } from "@/lib/calendar-events";
import { hhmmInZone, userTimeZone } from "@/lib/meeting-context";
import { isValidTimeZone, TZ_COOKIE, ymdInZone } from "@/lib/reminder-due-bucket";
import { captureRadarTimeZone } from "@/lib/radar/digest";

export async function TodayMeetingsSection({ now }: { now: Date }) {
  const userId = await requireUserId();
  // This browser's zone first, and remembered: the chat tools and the prep card read the saved
  // one, which until now only Settings and Radar recorded — so "my 3pm" was a UTC 3pm.
  const browserTz = (await cookies()).get(TZ_COOKIE)?.value;
  if (isValidTimeZone(browserTz)) after(() => captureRadarTimeZone(userId, browserTz).catch(() => undefined));
  const [tz, events] = await Promise.all([
    isValidTimeZone(browserTz) ? browserTz : userTimeZone(userId),
    // In progress counts (the read is by overlap); a day at most 24h ahead, cut to the local day below.
    listUpcomingEvents(userId, { from: now, to: new Date(now.getTime() + 86_400_000), limit: 30 }),
  ]);
  const today = ymdInZone(now, tz);
  const shown = events
    .filter((e) => !e.allDay && e.selfResponse !== "declined" && ymdInZone(e.startAt, tz) <= today)
    .slice(0, 6);
  if (!shown.length) return null;
  // Someone added since the last sync shows by name.
  const rows = await relinkEvents(userId, shown);

  const time = new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", minute: "2-digit" });

  return (
    <Card>
      <CardHeader>
        <CardTitle as="h2" className="flex items-center gap-2">
          <CalendarDays className="size-4 text-muted-foreground" aria-hidden />
          Today
        </CardTitle>
      </CardHeader>
      <CardContent>
        <ul className="divide-y divide-border-subtle">
          {rows.map((e) => {
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
          })}
        </ul>
      </CardContent>
    </Card>
  );
}
