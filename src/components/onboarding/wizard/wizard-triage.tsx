"use client";

import { useCallback, useEffect, useRef, useState, useTransition } from "react";
import {
  getTriageCandidates,
  rateContacts,
  type TriageDisplayCandidate,
} from "@/actions/contacts";
import { ContactAvatar } from "@/components/contacts/contact-avatar";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useImportJob } from "@/lib/import-job-runner";
import { toast } from "@/lib/toast";
import { cn } from "@/lib/utils";

/** Shown a screen at a time so the wizard never dumps the whole shortlist on one page. */
const SCREEN_SIZE = 8;

/** Same 1–5 scale as the contact-detail "Strength" field (contact-form.tsx). */
const RATING_VALUES = [1, 2, 3, 4, 5] as const;

export function WizardTriage({ onDone }: { onDone: () => void }) {
  const job = useImportJob();
  const [pending, start] = useTransition();
  const [loading, setLoading] = useState(true);
  // Distinct from "candidates is empty": a failed fetch must never render as
  // the same "nothing to rate" state a genuinely empty orbit would show, or
  // a broken request looks identical to having nobody left to ask about.
  const [loadError, setLoadError] = useState(false);
  const [candidates, setCandidates] = useState<TriageDisplayCandidate[]>([]);
  const [screen, setScreen] = useState(0);
  // Holds this screen's answers until `rateContacts` confirms they saved —
  // see submitScreenAndAdvance, which keeps whatever didn't save instead of
  // discarding it.
  const [ratings, setRatings] = useState<Record<string, number>>({});

  // No synchronous setState here — only the async .then/.catch/.finally
  // callbacks touch state, which is what keeps the mount-time effect below
  // from calling setState synchronously during render. `isCancelled` lets
  // each call site (the mount effect, the retry button) supply its own
  // "am I still relevant" check via a plain closure instead of a shared ref.
  const fetchCandidates = useCallback((isCancelled: () => boolean) => {
    getTriageCandidates()
      .then((data) => {
        if (!isCancelled()) setCandidates(data);
      })
      .catch(() => {
        if (!isCancelled()) setLoadError(true);
      })
      .finally(() => {
        if (!isCancelled()) setLoading(false);
      });
  }, []);

  useEffect(() => {
    let cancelled = false;
    fetchCandidates(() => cancelled);
    return () => {
      cancelled = true;
    };
  }, [fetchCandidates]);

  // The retry button's own click handler, not an effect — safe to flip
  // loading/error state synchronously here before kicking off a fresh fetch.
  // No cancellation guard needed beyond that: unlike the mount effect, this
  // path can't re-run out from under itself, so there's only ever one
  // in-flight request from here at a time.
  const retry = useCallback(() => {
    setLoading(true);
    setLoadError(false);
    fetchCandidates(() => false);
  }, [fetchCandidates]);

  // Re-fetches candidates the moment the running import job (e.g. the Google contacts
  // import just kicked off from the wizard's connect step) lands, so the person we were
  // about to ask about isn't stuck behind a stale "nothing to rate yet" read. The ref
  // remembers the last-seen status so this fires exactly once per running->completed
  // transition rather than on every render while the job stays completed; `retry` is
  // called from a callback reacting to the external job-runner singleton, not
  // synchronously in the effect body, matching the pattern in google-contacts-import.tsx.
  const lastJobStatusRef = useRef<string | undefined>(undefined);
  useEffect(() => {
    const prevStatus = lastJobStatusRef.current;
    lastJobStatusRef.current = job?.status;
    if (job?.status === "completed" && prevStatus === "running") {
      queueMicrotask(() => {
        retry();
      });
    }
  }, [job, retry]);

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
        let result: { updated: number; failedContactIds: string[] };
        try {
          result = await rateContacts(screenRatings);
        } catch {
          // Nothing saved — keep every local rating so "Next" can be
          // retried, and say so instead of silently advancing as if it had.
          toast.error("Couldn't save these ratings. Try again.");
          return;
        }
        if (result.failedContactIds.length > 0) {
          const failed = new Set(result.failedContactIds);
          // Drop only the ones that actually saved — a retry shouldn't
          // resubmit a rating that already landed.
          setRatings((r) => {
            const next = { ...r };
            for (const { contactId } of screenRatings) {
              if (!failed.has(contactId)) delete next[contactId];
            }
            return next;
          });
          toast.error(
            result.failedContactIds.length === 1
              ? "1 rating didn't save. Try again."
              : `${result.failedContactIds.length} ratings didn't save. Try again.`
          );
          // Stay on this screen — advancing would make the failure
          // indistinguishable from success, and a lost rating is exactly the
          // contact that stays stuck below the evidence floor.
          return;
        }
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

  if (loadError) {
    return (
      <div className="space-y-4">
        <p className="text-sm text-muted-foreground">
          Couldn&apos;t load anyone to rate. This is a loading problem, not an
          empty orbit — try again.
        </p>
        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            className="bg-primary text-primary-foreground hover:bg-primary/90"
            onClick={retry}
          >
            Try again
          </Button>
          <Button type="button" variant="outline" onClick={onDone}>
            Skip this step
          </Button>
        </div>
      </div>
    );
  }

  if (candidates.length === 0) {
    if (job?.status === "running") {
      return (
        <div className="space-y-4">
          <p className="text-sm text-muted-foreground">
            Importing {job.progress?.done ?? 0}/{job.progress?.total ?? 0}{" "}
            people — Orbit will ask about a few once they land.
          </p>
        </div>
      );
    }
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
              <p className="truncate font-medium text-ink">
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
                aria-label={`Skip ${c.fullName}`}
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
