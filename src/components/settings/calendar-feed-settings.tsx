"use client";

import { useEffect, useState, useTransition } from "react";
import { Apple, CalendarDays, Link2, Mail, RefreshCw } from "lucide-react";
import { toast } from "@/lib/toast";
import {
  disableCalendarFeed,
  enableCalendarFeed,
  getCalendarFeedStatus,
  regenerateCalendarFeedToken,
  type CalendarFeedStatus,
} from "@/actions/calendar-feed";
import { Button, buttonVariants } from "@/components/ui/button";
import { FeatureRow, LoadError, whenLine } from "@/components/settings/account-page";
import { SettingsRow } from "@/components/settings/settings-section";
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
  const [confirmingRegen, setConfirmingRegen] = useState(false);
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

  const statusLine = !status
    ? loadFailure
      ? "Couldn’t check"
      : "Checking…"
    : !status.enabled
      ? "Off"
      : status.lastFetchedAt
        ? `On · fetched ${whenLine(status.lastFetchedAt)}`
        : "On · waiting for your calendar’s first check";

  return (
    <SettingsRow
      id="settings-calendar"
      title="Reminders in your calendar"
      description={
        <>
          Due reminders in Google, Apple or Outlook ·{" "}
          <span role="status">{statusLine}</span>
        </>
      }
      action={
        loadFailure && !status ? null : (
          <>
            {status && !status.enabled ? (
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={pending}
                onClick={() => run("Calendar feed created", enableCalendarFeed)}
              >
                Create feed
              </Button>
            ) : null}
            {status?.enabled ? (
              <>
                {confirmingRegen ? null : (
                  <Button
                    ref={regenFocus.triggerRef("regen")}
                    type="button"
                    size="sm"
                    variant="ghost"
                    disabled={pending}
                    onClick={() => setConfirmingRegen(true)}
                  >
                    <RefreshCw aria-hidden />
                    Replace link
                  </Button>
                )}
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={pending}
                  onClick={() => run("Calendar feed turned off", disableCalendarFeed)}
                >
                  Turn off
                </Button>
              </>
            ) : null}
          </>
        )
      }
    >
      {loadFailure && !status ? (
        <LoadError what="calendar feed settings" onRetry={() => setReloadKey((k) => k + 1)} />
      ) : null}
      {status?.enabled ? (
        <>
          {confirmingRegen ? (
            <div role="status" className="flex flex-wrap items-center gap-2 rounded-xl border border-warning-border bg-warning-surface p-3 text-sm">
              <p className="min-w-0 flex-1">The old link stops working · re-subscribe on every device</p>
              <Button
                ref={regenFocus.confirmRef("regen")}
                size="sm"
                disabled={pending}
                onClick={() => run("New link created", regenerateCalendarFeedToken)}
              >
                Replace link
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setConfirmingRegen(false)}>
                Cancel
              </Button>
            </div>
          ) : null}

          {status.url ? (
            <ul className="-my-1">
              <FeatureRow
                icon={<Apple />}
                title="Apple Calendar"
                description="Set it to refresh every hour"
                control={{ kind: "action", label: "Open" }}
                onAction={() => {
                  window.location.href = status.webcalUrl!;
                }}
              />
              <FeatureRow
                icon={<CalendarDays />}
                title="Google Calendar"
                description="Refreshes every 8–24 hours · add alerts in its settings"
                control={{ kind: "action", label: "Open" }}
                onAction={() => window.open(status.googleAddUrl!, "_blank", "noreferrer")}
              />
              <FeatureRow
                icon={<Mail />}
                title="Outlook"
                description="Work or personal account"
                control={{ kind: "none" }}
                onAction={() => {}}
              >
                <div className="flex flex-wrap gap-2">
                  <a href={status.outlookOfficeAddUrl!} target="_blank" rel="noreferrer" className={buttonVariants({ variant: "outline", size: "sm" })}>
                    Work
                  </a>
                  <a href={status.outlookLiveAddUrl!} target="_blank" rel="noreferrer" className={buttonVariants({ variant: "outline", size: "sm" })}>
                    Personal
                  </a>
                </div>
              </FeatureRow>
              <FeatureRow
                icon={<Link2 />}
                title="Copy the link"
                description={<span className="font-mono text-xs break-all">{maskUrl(status.url)}</span>}
                control={{ kind: "action", label: "Copy" }}
                onAction={async () => {
                  try {
                    await navigator.clipboard.writeText(status.url!);
                    toast.success(TOAST_COPY.copied);
                  } catch {
                    toast.error(TOAST_COPY.copyFailed);
                  }
                }}
              />
            </ul>
          ) : (
            <p className="text-sm text-muted-foreground">
              Subscribed · Orbit can’t show this link again · replace it to add another calendar
            </p>
          )}

          <p className="text-xs text-muted-foreground">
            Keep the link private · anyone with it can read your reminders
          </p>
        </>
      ) : null}
    </SettingsRow>
  );
}
