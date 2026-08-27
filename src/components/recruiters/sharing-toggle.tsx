"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Globe2, Lock } from "lucide-react";
import { setRecruiterSharing } from "@/actions/recruiters";
import { toast } from "@/lib/toast";
import { Button } from "@/components/ui/button";

/**
 * The consent surface for the shared recruiter pool.
 *
 * Lives here rather than in Settings on purpose: this is where the exchange is legible
 * — the Discover tab next to it is either full or empty depending on this switch — and
 * it follows the house convention that integration and consent UI sits with its feature
 * (Gmail connect is on this page, Google Contacts on /imports).
 *
 * The copy states what leaves the account and what never does. That list is load-bearing,
 * not decoration: it is the only place a user is told that notes and AI summaries stay
 * private. Keep it in sync with `toPublicRecruiter`.
 */
export function RecruiterSharingToggle({ enabled }: { enabled: boolean }) {
  const router = useRouter();
  const [on, setOn] = useState(enabled);
  const [pending, start] = useTransition();

  function toggle(next: boolean) {
    start(async () => {
      const previous = on;
      setOn(next);
      try {
        await setRecruiterSharing(next);
        toast.success(
          next
            ? "Your recruiters are in the shared pool"
            : "Your recruiters are private again"
        );
        router.refresh();
      } catch (err) {
        setOn(previous);
        toast.error(
          err instanceof Error ? err.message : "Could not change sharing"
        );
      }
    });
  }

  return (
    <section className="space-y-4 rounded-2xl border border-border/70 bg-card p-5">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex gap-3">
          <div
            className={
              on
                ? "mt-0.5 h-9 w-9 shrink-0 rounded-full bg-primary/10 p-2 text-primary"
                : "mt-0.5 h-9 w-9 shrink-0 rounded-full bg-muted p-2 text-muted-foreground"
            }
          >
            {on ? (
              <Globe2 className="h-5 w-5" />
            ) : (
              <Lock className="h-5 w-5" />
            )}
          </div>
          <div className="min-w-0">
            <h2 className="font-medium text-ink">
              {on ? "Sharing with the pool" : "Your list is private"}
            </h2>
            <p className="mt-1 max-w-prose text-sm text-muted-foreground">
              {on
                ? "Your recruiters are in the shared pool, so you can see everyone else’s too."
                : "Share your recruiters to see the ones other people have logged. Private means you only ever see the recruiters you added yourself."}
            </p>
          </div>
        </div>

        <Button
          type="button"
          disabled={pending}
          variant={on ? "outline" : "default"}
          className={on ? undefined : "bg-primary text-primary-foreground"}
          onClick={() => toggle(!on)}
        >
          {pending ? "Saving…" : on ? "Make private" : "Share my list"}
        </Button>
      </div>

      <dl className="grid gap-3 border-t border-border/60 pt-4 text-sm sm:grid-cols-2">
        <div>
          <dt className="font-medium text-foreground">Shared when on</dt>
          <dd className="mt-1 text-muted-foreground">
            Recruiter name, firm, specialty, their work email and LinkedIn, and
            your star rating as part of the community average.
          </dd>
        </div>
        <div>
          <dt className="font-medium text-foreground">Never shared</dt>
          <dd className="mt-1 text-muted-foreground">
            Your notes, your AI interaction summaries, your status, and anything
            Orbit read from your inbox.
          </dd>
        </div>
      </dl>
    </section>
  );
}
