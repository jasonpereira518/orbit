/**
 * "People you keep seeing."
 *
 * The payoff for keeping rosters at all. Somebody you have now shared four rooms with and
 * never spoken to is a far better introduction than a stranger — and it is precisely the
 * thing nobody notices on their own, because each event feels separate at the time.
 *
 * A server component: it renders a list and links, and needs nothing from the browser.
 */
import { IntentLink } from "@/components/ui/intent-link";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import type { RepeatPerson } from "@/lib/events/people-store";

function lastSeen(date: Date | null): string | null {
  if (!date) return null;
  return date.toLocaleDateString(undefined, { month: "short", year: "numeric" });
}

export function RepeatPeoplePanel({ people }: { people: RepeatPerson[] }) {
  // Nothing to say yet. An empty "people you keep seeing" panel on a page with two events is
  // a promise the product has not earned, so it renders nothing at all until it has.
  if (people.length === 0) return null;

  return (
    <Card>
      <CardHeader>
        <CardTitle as="h2">People you keep seeing</CardTitle>
        <CardDescription>
          They were in the room more than once. The ones you haven’t connected yet are usually
          the easiest introductions you will ever make.
        </CardDescription>
      </CardHeader>
      <CardContent>
      <ul className="divide-y divide-border-subtle">
        {people.map((person) => {
          const detail = [person.title, person.company].filter(Boolean).join(" · ");
          const seen = lastSeen(person.lastTogetherAt);
          return (
            <li
              key={person.clusterKey}
              className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 py-2.5"
            >
              <div className="min-w-0">
                <p className="truncate text-sm font-medium text-ink">
                  {person.contactId ? (
                    <IntentLink href={`/contacts/${person.contactId}`} className="hover:underline">
                      {person.name ?? "Someone"}
                    </IntentLink>
                  ) : (
                    (person.name ?? "Someone")
                  )}
                </p>
                {detail ? (
                  <p className="truncate text-xs text-muted-foreground">{detail}</p>
                ) : null}
              </div>
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <Badge tone="neutral" size="sm">
                  {person.eventsTogether} events
                </Badge>
                {seen ? <span>last {seen}</span> : null}
                {/* The honest state: on a roster, not in your contacts. This is the row worth
                    acting on, so it says so rather than looking like an error. */}
                {person.connected ? null : (
                  <Badge variant="outline" size="sm" className="text-muted-foreground">
                    Not a contact yet
                  </Badge>
                )}
              </div>
            </li>
          );
        })}
      </ul>
      </CardContent>
    </Card>
  );
}
