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

/** Shows enough of the token to identify the link without exposing it on screen. */
function maskUrl(url: string) {
  return url.replace(/\/api\/calendar\/([^.]+)/, (_m, token: string) => {
    const tail = token.slice(-4);
    return `/api/calendar/${"•".repeat(8)}${tail}`;
  });
}

export function CalendarFeedSettings() {
  const [status, setStatus] = useState<CalendarFeedStatus | null>(null);
  const [revealed, setRevealed] = useState(false);
  const [confirmingRegen, setConfirmingRegen] = useState(false);
  const [pending, start] = useTransition();

  useEffect(() => {
    let cancelled = false;
    getCalendarFeedStatus()
      .then((s) => {
        if (!cancelled) setStatus(s);
      })
      .catch(() => {
        if (!cancelled) toast.error("Could not load calendar feed settings");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  function run(label: string, fn: () => Promise<CalendarFeedStatus>) {
    start(async () => {
      try {
        const next = await fn();
        setStatus(next);
        setConfirmingRegen(false);
        setRevealed(false);
        toast.success(label);
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Something went wrong");
      }
    });
  }

  return (
    <section className="space-y-3 rounded-2xl border border-border/70 bg-card p-6">
      <div>
        <h2 className="text-lg font-medium text-primary">Calendar feed</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Subscribe to your reminders in Google Calendar, Apple Calendar, or
          Outlook so they show up alongside everything else.
        </p>
      </div>

      {!status ? (
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
