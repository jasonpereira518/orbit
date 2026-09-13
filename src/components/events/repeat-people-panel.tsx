/**
 * "People you keep seeing."
 *
 * The payoff for keeping rosters at all. Somebody you have now shared four rooms with and
 * never spoken to is a far better introduction than a stranger — and it is precisely the
 * thing nobody notices on their own, because each event feels separate at the time.
 *
 * A server component: it renders a list and links, and needs nothing from the browser.
 */
import Link from "next/link";
import { Users } from "lucide-react";
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
    <div className="rounded-2xl border border-border/70 bg-card p-5">
      <h2 className="flex items-center gap-2 font-medium text-ink">
        <Users className="size-4 text-muted-foreground" aria-hidden />
        People you keep seeing
      </h2>
      <p className="mt-1 text-sm text-muted-foreground">
        They were in the room more than once. The ones you have not connected yet are usually
        the easiest introductions you will ever make.
      </p>

      <ul className="mt-4 divide-y divide-border/60">
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
                    <Link href={`/contacts/${person.contactId}`} className="hover:underline">
                      {person.name ?? "Someone"}
                    </Link>
                  ) : (
                    (person.name ?? "Someone")
                  )}
                </p>
                {detail ? (
                  <p className="truncate text-xs text-muted-foreground">{detail}</p>
                ) : null}
              </div>
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <span className="rounded-full bg-muted px-2 py-0.5 font-medium text-ink">
                  {person.eventsTogether} events
                </span>
                {seen ? <span>last {seen}</span> : null}
                {/* The honest state: on a roster, not in the network. This is the row worth
                    acting on, so it says so rather than looking like an error. */}
                {person.connected ? null : (
                  <span className="rounded-full border border-border/70 px-2 py-0.5">
                    Not a contact yet
                  </span>
                )}
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
