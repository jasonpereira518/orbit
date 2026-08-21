"use client";

import { useEffect, useState, useTransition } from "react";
import {
  getTriageCandidates,
  rateContacts,
  type TriageDisplayCandidate,
} from "@/actions/contacts";
import { ContactAvatar } from "@/components/contacts/contact-avatar";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

/** Shown a screen at a time so the wizard never dumps the whole shortlist on one page. */
const SCREEN_SIZE = 8;

/** Same 1–5 scale as the contact-detail "Strength" field (contact-form.tsx). */
const RATING_VALUES = [1, 2, 3, 4, 5] as const;

export function WizardTriage({ onDone }: { onDone: () => void }) {
  const [pending, start] = useTransition();
  const [loading, setLoading] = useState(true);
  const [candidates, setCandidates] = useState<TriageDisplayCandidate[]>([]);
  const [screen, setScreen] = useState(0);
  // Only holds *this screen's* answers, submitted then discarded on advance —
  // once `rateContacts` saves them the person drops out of a re-fetched
  // shortlist anyway (see getTriageCandidates), so there's nothing to keep.
  const [ratings, setRatings] = useState<Record<string, number>>({});

  useEffect(() => {
    let cancelled = false;
    getTriageCandidates()
      .then((data) => {
        if (!cancelled) setCandidates(data);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const screens = Math.max(1, Math.ceil(candidates.length / SCREEN_SIZE));
  const pageItems = candidates.slice(
    screen * SCREEN_SIZE,
    screen * SCREEN_SIZE + SCREEN_SIZE
  );
  const isLastScreen = screen + 1 >= screens;

  const rate = (id: string, value: number) => {
    setRatings((r) => ({ ...r, [id]: value }));
  };

  const clearRating = (id: string) => {
    setRatings((r) => {
      if (!(id in r)) return r;
      const next = { ...r };
      delete next[id];
      return next;
    });
  };

  const submitScreenAndAdvance = () => {
    // Leaving someone unrated (never touched, or explicitly skipped) just
    // means they're absent here — as easy as rating them, since it takes no
    // action at all.
    const screenRatings = pageItems
      .filter((c) => ratings[c.id] != null)
      .map((c) => ({ contactId: c.id, closeness: ratings[c.id] }));

    start(async () => {
      if (screenRatings.length > 0) {
        await rateContacts(screenRatings);
      }
      setRatings({});
      if (isLastScreen) {
        onDone();
      } else {
        setScreen((s) => s + 1);
      }
    });
  };

  if (loading) {
    return (
      <div className="space-y-3">
        <Skeleton className="h-20 w-full rounded-2xl" />
        <Skeleton className="h-20 w-full rounded-2xl" />
        <Skeleton className="h-20 w-full rounded-2xl" />
      </div>
    );
  }

  if (candidates.length === 0) {
    return (
      <div className="space-y-4">
        <p className="text-sm text-muted-foreground">
          Nothing to rate yet — Orbit asks about people once it has some to
          ask about.
        </p>
        <Button
          type="button"
          className="bg-primary text-primary-foreground hover:bg-primary/90"
          onClick={onDone}
        >
          Continue
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-3">
        <p className="text-sm text-muted-foreground">
          How close are you to these people? Rate the ones you can — skip the
          rest.
        </p>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={pending}
          className="shrink-0 text-muted-foreground"
          onClick={onDone}
        >
          Skip this step
        </Button>
      </div>

      <div className="space-y-3">
        {pageItems.map((c) => (
          <div
            key={c.id}
            className="flex flex-wrap items-center gap-3 rounded-2xl border border-border/70 bg-background/70 p-4"
          >
            <ContactAvatar
              contactId={c.id}
              firstName={c.firstName}
              fullName={c.fullName}
              linkedinUrl={c.linkedinUrl}
              profileImageUrl={c.profileImageUrl}
              size="default"
            />
            <div className="min-w-0 flex-1">
              <p className="truncate font-medium text-primary">
                {c.fullName}
              </p>
              <p className="truncate text-xs text-muted-foreground">
                {[c.title, c.company].filter(Boolean).join(" · ") ||
                  "No details yet"}
              </p>
            </div>
            <div className="flex items-center gap-1">
              {RATING_VALUES.map((value) => (
                <button
                  key={value}
                  type="button"
                  disabled={pending}
                  aria-pressed={ratings[c.id] === value}
                  aria-label={`Rate ${c.fullName} ${value} out of 5`}
                  onClick={() => rate(c.id, value)}
                  className={cn(
                    "flex h-8 w-8 items-center justify-center rounded-full border text-sm font-medium transition-colors disabled:pointer-events-none disabled:opacity-50",
                    ratings[c.id] === value
                      ? "border-primary bg-primary text-primary-foreground"
                      : "border-border/70 bg-background/70 text-muted-foreground hover:border-primary/25 hover:bg-accent"
                  )}
                >
                  {value}
                </button>
              ))}
              <button
                type="button"
                disabled={pending}
                onClick={() => clearRating(c.id)}
                className="ml-1 rounded-full px-2 py-1 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground disabled:pointer-events-none disabled:opacity-50"
              >
                Skip
              </button>
            </div>
          </div>
        ))}
      </div>

      <div className="flex items-center justify-between border-t border-border/60 pt-4">
        <p className="text-xs text-muted-foreground">
          Screen {screen + 1} of {screens}
        </p>
        <Button
          type="button"
          className="bg-primary text-primary-foreground hover:bg-primary/90"
          disabled={pending}
          onClick={submitScreenAndAdvance}
        >
          {pending ? "Saving…" : isLastScreen ? "Finish" : "Next"}
        </Button>
      </div>
    </div>
  );
}
