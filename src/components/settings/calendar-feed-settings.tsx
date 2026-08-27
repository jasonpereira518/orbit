"use client";

import { useEffect, useState, useTransition } from "react";
import { formatDistanceToNow } from "date-fns";
import { toast } from "@/lib/toast";
import {
  disableCalendarFeed,
  enableCalendarFeed,
  getCalendarFeedStatus,
  regenerateCalendarFeedToken,
  type CalendarFeedStatus,
} from "@/actions/calendar-feed";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

/**
 * How long to wait for the status action before giving up on it.
 *
 * This exists because the failure seen in production is a *hang*, not a rejection:
 * the action never settles, so a plain .catch() never fires and the panel sits on
 * "Loading…" forever. Racing a timer converts that into a rejection the UI can show
 * and the user can retry. Note this only stops the client waiting — the server action
 * itself keeps running to completion or its own platform timeout.
 */
const LOAD_TIMEOUT_MS = 12_000;

const TIMED_OUT = "orbit:timed-out";

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(TIMED_OUT)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      }
    );
  });
}

/** Shows enough of the token to identify the link without exposing it on screen. */
function maskUrl(url: string) {
  return url.replace(/\/api\/calendar\/([^.]+)/, (_m, token: string) => {
    const tail = token.slice(-4);
    return `/api/calendar/${"•".repeat(8)}${tail}`;
  });
}

export function CalendarFeedSettings() {
  const [status, setStatus] = useState<CalendarFeedStatus | null>(null);
  const [loadFailure, setLoadFailure] = useState<"timeout" | "error" | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [revealed, setRevealed] = useState(false);
  const [confirmingRegen, setConfirmingRegen] = useState(false);
  const [pending, start] = useTransition();

  // A failed load must be visible and recoverable. Without this the section sits on
  // "Loading…" forever — a dead panel with no way to retry. The two failure modes are
  // kept distinct on purpose: knowing whether the action rejected or simply never
  // answered is the signal needed to chase the underlying cause.
  useEffect(() => {
    let cancelled = false;
    setLoadFailure(null);
    withTimeout(getCalendarFeedStatus(), LOAD_TIMEOUT_MS)
      .then((s) => {
        if (!cancelled) setStatus(s);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        const timedOut = err instanceof Error && err.message === TIMED_OUT;
        setLoadFailure(timedOut ? "timeout" : "error");
      });
    return () => {
      cancelled = true;
    };
  }, [reloadKey]);

  // Mutations get the same timeout as the initial load. Without it a stalled
  // create/regenerate/disable never rejects, so this catch never runs and the
  // button simply does nothing — a silent no-op with no way to tell it failed.
  function run(label: string, fn: () => Promise<CalendarFeedStatus>) {
    start(async () => {
      try {
        const next = await withTimeout(fn(), LOAD_TIMEOUT_MS);
        setStatus(next);
        setConfirmingRegen(false);
        setRevealed(false);
        toast.success(label);
      } catch (err) {
        const timedOut = err instanceof Error && err.message === TIMED_OUT;
        toast.error(
          timedOut
            ? "That took too long. Please try again."
            : err instanceof Error
              ? err.message
              : "Something went wrong"
        );
      }
    });
  }

  return (
    <section className="space-y-3 rounded-2xl border border-border/70 bg-card p-6">
      <div>
        <h2 className="text-lg font-medium text-ink">Calendar feed</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Subscribe to your reminders in Google Calendar, Apple Calendar, or
          Outlook so they show up alongside everything else.
        </p>
      </div>

      {loadFailure && !status ? (
        <div className="space-y-2">
          <p className="text-sm text-muted-foreground">
            {loadFailure === "timeout"
              ? "Your calendar feed settings took too long to load."
              : "Couldn't load your calendar feed settings."}
          </p>
          <Button
            size="sm"
            variant="outline"
            onClick={() => setReloadKey((k) => k + 1)}
          >
            Try again
          </Button>
        </div>
      ) : !status ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : !status.enabled ? (
        <div className="space-y-3">
          <p className="text-sm text-muted-foreground">
            Creates a private link your calendar app checks periodically.
          </p>
          <Button
            disabled={pending}
            className="bg-primary text-primary-foreground hover:bg-primary/90"
            onClick={() => run("Calendar feed created", enableCalendarFeed)}
          >
            Create calendar feed
          </Button>
        </div>
      ) : (
        <div className="space-y-4">
          <div className="space-y-2">
            <Input
              readOnly
              value={
                revealed ? status.url! : maskUrl(status.url!)
              }
              onFocus={(e) => e.currentTarget.select()}
              className="font-mono text-xs"
              aria-label="Calendar feed URL"
            />
            <div className="flex flex-wrap gap-2">
              <Button
                size="sm"
                variant="outline"
                onClick={() => setRevealed((v) => !v)}
              >
                {revealed ? "Hide" : "Reveal"}
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={async () => {
                  await navigator.clipboard.writeText(status.url!);
                  toast.success("Copied to clipboard");
                }}
              >
                Copy link
              </Button>
              <a
                href={status.webcalUrl!}
                className="inline-flex h-8 items-center rounded-md border border-input px-3 text-sm hover:bg-accent"
              >
                Add to Apple Calendar
              </a>
              <a
                href={status.googleAddUrl!}
                target="_blank"
                rel="noreferrer"
                className="inline-flex h-8 items-center rounded-md border border-input px-3 text-sm hover:bg-accent"
              >
                Add to Google Calendar
              </a>
            </div>
          </div>

          <p className="text-xs text-muted-foreground">
            {status.lastFetchedAt
              ? `Last fetched by a calendar app ${formatDistanceToNow(
                  new Date(status.lastFetchedAt),
                  { addSuffix: true }
                )}.`
              : "Not fetched yet — calendar apps can take several hours to check the first time."}
          </p>

          <ul className="space-y-1 text-xs text-muted-foreground">
            <li>
              <strong className="text-foreground">Keep this link secret.</strong>{" "}
              Anyone who has it can read your reminder titles, notes, and contact
              names.
            </li>
            <li>
              Google Calendar refreshes subscribed calendars on its own schedule
              — often 8–24 hours — so new reminders may not appear right away.
            </li>
            <li>
              In Google Calendar, add a notification to the subscribed calendar
              in its settings. Google ignores the alerts inside the feed.
            </li>
            <li>
              In Apple Calendar, set the subscription to refresh every hour and
              leave &ldquo;Remove alerts&rdquo; unchecked.
            </li>
            <li>Only reminders with a due date appear in your calendar.</li>
          </ul>

          <div className="flex flex-wrap gap-2">
            {confirmingRegen ? (
              <>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={pending}
                  onClick={() =>
                    run("New link created", regenerateCalendarFeedToken)
                  }
                >
                  Yes, replace the link
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => setConfirmingRegen(false)}
                >
                  Cancel
                </Button>
                <p className="w-full text-xs text-muted-foreground">
                  Your old link stops working immediately. You&apos;ll need to
                  re-subscribe on every device.
                </p>
              </>
            ) : (
              <Button
                size="sm"
                variant="outline"
                disabled={pending}
                onClick={() => setConfirmingRegen(true)}
              >
                Regenerate link
              </Button>
            )}
            <Button
              size="sm"
              variant="ghost"
              disabled={pending}
              onClick={() => run("Calendar feed turned off", disableCalendarFeed)}
            >
              Turn off
            </Button>
          </div>
        </div>
      )}
    </section>
  );
}
