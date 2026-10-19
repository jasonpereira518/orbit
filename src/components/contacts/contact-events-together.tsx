/**
 * The events this person and the user were both at.
 *
 * The other half of "people you keep seeing", seen from the person rather than the room. It
 * answers the question you actually have when you open somebody's page before a meeting —
 * where do I know them from — and it works before anybody has been connected to anything,
 * because a roster row resolves to a contact through `contact_identities`.
 *
 * `spokeTo` is shown because the difference matters: "we were both at three events" and "we
 * have actually spoken at three events" are different relationships.
 */
import Link from "next/link";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { EventTogether } from "@/lib/events/people-store";

export function ContactEventsTogether({
  events,
  name,
}: {
  events: EventTogether[];
  name: string;
}) {
  if (events.length === 0) return null;

  return (
    <Card>
      <CardHeader>
        <CardTitle as="h2">Events with {name}</CardTitle>
      </CardHeader>
      <CardContent>
        <ul className="divide-y divide-border-subtle">
          {events.map((event) => (
            <li key={event.eventId} className="flex items-center justify-between gap-3 py-2">
              <Link
                href={`/events/${event.eventId}`}
                className="min-w-0 truncate text-sm text-ink hover:underline"
              >
                {event.title}
              </Link>
              <span className="shrink-0 text-xs text-muted-foreground">
                {event.startsAt
                  ? event.startsAt.toLocaleDateString(undefined, {
                      month: "short",
                      year: "numeric",
                    })
                  : "Date not set"}
                {/* The distinction worth keeping: in the same room, or actually met. */}
                {event.spokeTo ? " · spoke" : ""}
              </span>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}
