"use client";

import { useEffect, useState, useTransition } from "react";
import { formatDistanceToNow } from "date-fns";
import { toast } from "@/lib/toast";
import {
  disableCalendarFeed,
  enableCalendarFeed,
  getCalendarFeedStatus,
  regenerateCalendarFeedToken,
  type CalendarFeedLinks,
  type CalendarFeedStatus,
} from "@/actions/calendar-feed";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { SettingsSection } from "@/components/settings/settings-section";
import { useConfirmFocus } from "@/components/settings/use-confirm-focus";
import { TOAST_COPY } from "@/lib/toast-copy";
import { friendlyError, TIMEOUT_MESSAGE } from "@/lib/errors";

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

export function CalendarFeedSettings() {
  const [status, setStatus] = useState<CalendarFeedStatus | null>(null);
  const [loadFailure, setLoadFailure] = useState<"timeout" | "error" | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [confirmingRegen, setConfirmingRegen] = useState(false);
  // Held only in memory, separate from `status`: the server never stores the raw token, so
  // this is the only copy that will ever exist, and it must not survive a reload.
  const [revealedLinks, setRevealedLinks] = useState<CalendarFeedLinks | null>(null);
  const [pending, start] = useTransition();
  const regenFocus = useConfirmFocus(confirmingRegen ? "regen" : null);

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
        setRevealedLinks(next.links);
        toast.success(label);
      } catch (err) {
        const timedOut = err instanceof Error && err.message === TIMED_OUT;
        toast.error(
          timedOut
            ? TIMEOUT_MESSAGE
            : friendlyError(err, "That didn’t work — try again?")
        );
      }
    });
  }

  return (
    <SettingsSection
      title="Calendar feed"
      description="Subscribe to your reminders in Google Calendar, Apple Calendar, or Outlook so they show up alongside everything else."
    >

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
        <div className="space-y-2" aria-busy="true" aria-label="Loading calendar feed">
          <Skeleton className="h-4 w-2/3" />
          <Skeleton className="h-9 w-44 rounded-lg" />
        </div>
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
          {revealedLinks ? (
            <div className="space-y-2 rounded-lg border border-primary/40 bg-primary/5 p-4">
              <p className="text-sm font-medium text-ink">
                Copy this now — it will not be shown again.
              </p>
              <p className="text-xs text-muted-foreground">
                Orbit stores only a hash of this link, so it can&apos;t be recovered or
                re-displayed later. If you lose it, regenerate to get a new one.
              </p>
              <Input
                readOnly
                value={revealedLinks.url}
                onFocus={(e) => e.currentTarget.select()}
                className="font-mono text-xs"
                aria-label="Calendar feed URL"
              />
              <div className="flex flex-wrap gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  onClick={async () => {
                    await navigator.clipboard.writeText(revealedLinks.url);
                    toast.success(TOAST_COPY.copied);
                  }}
                >
                  Copy link
                </Button>
                <a
                  href={revealedLinks.webcalUrl}
                  className="inline-flex h-8 items-center rounded-md border border-input px-3 text-sm hover:bg-accent"
                >
                  Add to Apple Calendar
                </a>
                <a
                  href={revealedLinks.googleAddUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex h-8 items-center rounded-md border border-input px-3 text-sm hover:bg-accent"
                >
                  Add to Google Calendar
                </a>
                <Button size="sm" variant="ghost" onClick={() => setRevealedLinks(null)}>
                  Done
                </Button>
              </div>
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">
              Your link isn&apos;t shown again after creation. If you didn&apos;t save it
              (or added a new device), regenerate one below.
            </p>
          )}

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
                  ref={regenFocus.confirmRef("regen")}
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
                <p role="status" className="w-full text-xs text-muted-foreground">
                  Your old link stops working immediately. You&apos;ll need to
                  re-subscribe on every device.
                </p>
              </>
            ) : (
              <Button
                ref={regenFocus.triggerRef("regen")}
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
    </SettingsSection>
  );
}
