/**
 * "People you met" — the top of a past event, and the way into its debrief.
 *
 * Reads the roster rows marked met (every save from "Log who you met" marks them, see
 * `recordMetAtEvent`). With nobody logged yet it is a single call to action, because the morning
 * after is exactly when the user remembers who they talked to and is about to forget.
 *
 * A server component: a list and two links.
 */
import Link from "next/link";
import { NotebookPen, UserCheck } from "lucide-react";
import { IntentLink } from "@/components/ui/intent-link";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { RosterRow } from "@/lib/events/types";

export function PeopleYouMet({ eventId, rows }: { eventId: string; rows: RosterRow[] }) {
  const met = rows.filter((row) => row.spokeTo && row.contactId);
  const logHref = `/capture?eventId=${eventId}`;

  return (
    <div className="rounded-2xl border border-border/70 bg-card p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="flex items-center gap-2 font-medium text-ink">
            <UserCheck className="size-4 text-muted-foreground" aria-hidden />
            {met.length ? `People you met (${met.length})` : "Who did you meet?"}
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            {met.length
              ? "Each one is a contact with this event on their timeline."
              : "Type names and what you talked about, or paste their LinkedIn links. Each person becomes a contact with a note and a follow-up."}
          </p>
        </div>
        <Link href={logHref} className={cn(buttonVariants({ variant: met.length ? "outline" : "default" }))}>
          <NotebookPen className="size-4" aria-hidden />
          {met.length ? "Log more people" : "Log who you met"}
        </Link>
      </div>

      {met.length ? (
        <ul className="mt-4 divide-y divide-border/60">
          {met.map((row) => (
            <li key={row.id} className="py-2">
              <IntentLink
                href={`/contacts/${row.contactId}`}
                className="flex min-w-0 items-baseline gap-2 text-sm hover:underline"
              >
                <span className="truncate font-medium text-ink">{row.fullName ?? row.email ?? "Unnamed"}</span>
                <span className="truncate text-xs text-muted-foreground">
                  {[row.title, row.company].filter(Boolean).join(" · ")}
                </span>
              </IntentLink>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
