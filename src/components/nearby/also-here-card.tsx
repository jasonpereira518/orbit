"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Link2, Mail, Users } from "lucide-react";
import { Button } from "@/components/ui/button";
import { setHiddenHere } from "@/actions/nearby";
import type { AlsoHereView } from "@/lib/nearby/also-here-view";
import { friendlyError } from "@/lib/errors";
import { useGuardedTransition } from "@/lib/single-flight";
import { toast } from "@/lib/toast";

/** "Orbit people here": opted-in Orbit users at this live event, as their public cards. */
export function AlsoHereCard({ eventId, view }: { eventId: string; view: AlsoHereView }) {
  const router = useRouter();
  const [hidden, setHidden] = useState(view.hiddenHere);
  const [pending, start] = useGuardedTransition();

  const toggleHidden = () =>
    start(async () => {
      const next = !hidden;
      try {
        const result = await setHiddenHere(eventId, next);
        if (!result.ok) {
          toast.error(result.message);
          return;
        }
        setHidden(next);
        router.refresh();
      } catch (err) {
        toast.error(friendlyError(err, "Couldn’t change that — try again?"));
      }
    });

  return (
    <section aria-labelledby="also-here-title" className="rounded-2xl border border-border/70 bg-card p-4 sm:p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 id="also-here-title" className="flex items-center gap-2 font-display text-lg">
          <Users aria-hidden className="size-4 text-primary" /> Orbit people here
        </h2>
        {view.discoverable && view.hasCard ? (
          <Button type="button" size="sm" variant="outline" disabled={pending} onClick={toggleHidden} aria-pressed={hidden}>
            {hidden ? "Show me at this event" : "Hide me at this event"}
          </Button>
        ) : null}
      </div>

      <div className="mt-3 text-sm">
        {!view.hasCard ? (
          <p className="text-muted-foreground">
            People here see each other&rsquo;s Orbit card.{" "}
            <Link href="/card" className="font-medium text-primary underline-offset-4 hover:underline">
              Create your card
            </Link>
          </p>
        ) : !view.discoverable ? (
          <p className="text-muted-foreground">
            Turn on{" "}
            <Link href="/settings#settings-data" className="font-medium text-primary underline-offset-4 hover:underline">
              &ldquo;Let people at the same event find me&rdquo;
            </Link>{" "}
            to see who else is here.
          </p>
        ) : hidden ? (
          <p className="text-muted-foreground">You&rsquo;re hidden at this event, so you won&rsquo;t see anyone either.</p>
        ) : view.people.length === 0 ? (
          <p className="text-muted-foreground">No one else here has turned this on yet.</p>
        ) : (
          <ul className="grid gap-3 sm:grid-cols-2">
            {view.people.map((p) => (
              <li key={p.cardId} className="flex gap-3 rounded-xl border border-border/60 p-3">
                {p.photoUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element -- remote avatar of any host, like the card page
                  <img src={p.photoUrl} alt="" className="size-10 shrink-0 rounded-full object-cover" />
                ) : (
                  <span aria-hidden className="grid size-10 shrink-0 place-items-center rounded-full bg-muted font-medium">
                    {p.firstName.slice(0, 1)}
                  </span>
                )}
                <div className="min-w-0">
                  <p className="font-medium">{p.fullName}</p>
                  {p.title || p.company ? (
                    <p className="truncate text-muted-foreground">{[p.title, p.company].filter(Boolean).join(" @ ")}</p>
                  ) : null}
                  {p.headline ? <p className="line-clamp-2 text-muted-foreground">{p.headline}</p> : null}
                  <div className="mt-1 flex gap-3">
                    {p.linkedinUrl ? (
                      <a href={p.linkedinUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-primary">
                        <Link2 aria-hidden className="size-3.5" /> LinkedIn
                      </a>
                    ) : null}
                    {p.email ? (
                      <a href={`mailto:${p.email}`} className="inline-flex items-center gap-1 text-primary">
                        <Mail aria-hidden className="size-3.5" /> Email
                      </a>
                    ) : null}
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
