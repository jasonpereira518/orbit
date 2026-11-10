"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Globe2, Lock } from "lucide-react";
import { setRecruiterSharing } from "@/actions/recruiters";
import { toast } from "@/lib/toast";
import { Button } from "@/components/ui/button";
import { friendlyError } from "@/lib/errors";

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
 * private. Keep it in sync with `toPublicRecruiter` and `resolveRecruiterPii`: contact
 * details live on each user's own link, and reach the pool only while a pooled link
 * vouches for them — and only callers that share may add them to a shared row
 * (`logRecruiter`, the Gmail scan).
 */
export function RecruiterSharingToggle({
  enabled,
  recruiterCount = 0,
  minRequired = 5,
}: {
  enabled: boolean;
  recruiterCount?: number;
  minRequired?: number;
}) {
  const router = useRouter();
  const [on, setOn] = useState(enabled);
  const [pending, start] = useTransition();

  const canShare = on || recruiterCount >= minRequired;

  function toggle(next: boolean) {
    if (next && recruiterCount < minRequired) {
      toast.error(`You need at least ${minRequired} recruiters in your list to join the shared pool.`);
      return;
    }
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
          friendlyError(err, "Couldn’t change sharing — try again?")
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
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="font-medium text-ink">
                {on ? "Sharing with the pool" : "Your list is private"}
              </h2>
              {!on && (
                <span className="rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground">
                  {recruiterCount}/{minRequired} logged to unlock
                </span>
              )}
            </div>
            <p className="mt-1 max-w-prose text-sm text-muted-foreground">
              {on
                ? "Your recruiters are in the shared pool, so you can see everyone else’s too."
                : recruiterCount < minRequired
                  ? `Contribute at least ${minRequired} recruiters from your recruiting cycle to unlock the community pool of recruiters.`
                  : "Share your recruiters to see the ones other people have logged. Private means you only ever see the recruiters you added yourself."}
            </p>
          </div>
        </div>

        <Button
          type="button"
          disabled={pending || !canShare}
          variant={on ? "outline" : "default"}
          className={on ? undefined : "bg-primary text-primary-foreground"}
          onClick={() => toggle(!on)}
        >
          {pending
            ? "Saving…"
            : on
              ? "Make private"
              : canShare
                ? "Share my list"
                : `Need ${minRequired} recruiters (${recruiterCount}/${minRequired})`}
        </Button>
      </div>

      <dl className="grid gap-3 border-t border-border/60 pt-4 text-sm sm:grid-cols-2">
        <div>
          <dt className="font-medium text-foreground">Shared while you share</dt>
          <dd className="mt-1 text-muted-foreground">
            Each recruiter’s name, firm, role and specialty, and your star rating as
            part of the community average. Their contact details are stored in the
            central database without linking back to your personal name.
          </dd>
        </div>
        <div>
          <dt className="font-medium text-foreground">Never shared</dt>
          <dd className="mt-1 text-muted-foreground">
            Your name or identity is never attached to shared recruiters. Your personal
            notes, your AI conversation summaries, and raw emails are strictly private.
          </dd>
        </div>
      </dl>
    </section>
  );
}
