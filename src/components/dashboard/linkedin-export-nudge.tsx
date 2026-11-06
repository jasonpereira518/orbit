"use client";

import { useCallback, useSyncExternalStore } from "react";
import Link from "next/link";
import { ExternalLink, FileArchive, RefreshCw, Search, X } from "lucide-react";
import { Button, buttonVariants } from "@/components/ui/button";
import { linkedInArchiveSearch } from "@/lib/inbox-search";
import { LINKEDIN_DATA_URL } from "@/lib/linkedin-export";
import { cn } from "@/lib/utils";

const DISMISS_KEY = "orbit-linkedin-export-nudge-dismissed-v1";
const listeners = new Set<() => void>();

function readDismissed() {
  try {
    return localStorage.getItem(DISMISS_KEY) === "1";
  } catch {
    return false;
  }
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * The quiet follow-on to the full-screen LinkedIn reminder: one line on the dashboard with
 * the same two links, until the export is uploaded (the server stops rendering it) or the
 * user dismisses it on this device.
 *
 * The server snapshot is "dismissed", so nothing renders into the HTML and a dismissed card
 * never flashes before hydration reads localStorage.
 */
export function LinkedInExportNudge({ email }: { email: string | null }) {
  const dismissed = useSyncExternalStore(subscribe, readDismissed, () => true);
  const dismiss = useCallback(() => {
    try {
      localStorage.setItem(DISMISS_KEY, "1");
    } catch {
      // Private mode or a full quota: the card just comes back next visit.
    }
    listeners.forEach((l) => l());
  }, []);

  if (dismissed) return null;
  const search = linkedInArchiveSearch(email);

  return (
    <section
      aria-label="LinkedIn export"
      className="reveal-mount flex flex-col gap-3 rounded-2xl border border-border/70 bg-card px-4 py-3 sm:flex-row sm:items-center"
    >
      <div className="flex min-w-0 flex-1 items-center gap-3">
        <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-accent text-primary">
          <FileArchive className="size-4" aria-hidden />
        </span>
        <p className="min-w-0 text-sm">
          <span className="font-medium text-ink">Waiting on your LinkedIn export?</span>{" "}
          <span className="text-muted-foreground">
            Find LinkedIn&apos;s email, then upload the ZIP to bring in your connections.
          </span>
        </p>
      </div>
      <div className="flex shrink-0 items-center gap-1.5">
        <a
          href={search.url}
          target="_blank"
          rel="noopener noreferrer"
          className={cn(buttonVariants({ variant: "outline", size: "sm" }))}
        >
          <Search aria-hidden />
          {search.label}
        </a>
        <Link href="/imports#import-panel-connections" className={cn(buttonVariants({ size: "sm" }))}>
          Upload
        </Link>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          className="text-muted-foreground"
          onClick={dismiss}
          aria-label="Dismiss LinkedIn export reminder"
        >
          <X aria-hidden />
        </Button>
      </div>
    </section>
  );
}

const REFRESH_SNOOZE_KEY = "orbit-linkedin-refresh-snoozed-at-v1";
const REFRESH_SNOOZE_MS = 14 * 24 * 60 * 60 * 1000;

function readRefreshSnoozed() {
  try {
    const at = Number(localStorage.getItem(REFRESH_SNOOZE_KEY));
    return Number.isFinite(at) && at > 0 && Date.now() - at < REFRESH_SNOOZE_MS;
  } catch {
    return false;
  }
}

/**
 * The urgent half of the LinkedIn refresh reminder: the last upload is three months old, so
 * the dashboard leads with it (the bell has been asking since 30 days). Dismissing snoozes it
 * for two weeks on this device; a new upload stops the server rendering it at all.
 */
export function LinkedInRefreshNudge({ days }: { days: number }) {
  const snoozed = useSyncExternalStore(subscribe, readRefreshSnoozed, () => true);
  const snooze = useCallback(() => {
    try {
      localStorage.setItem(REFRESH_SNOOZE_KEY, String(Date.now()));
    } catch {
      // Private mode or a full quota: the card just comes back next visit.
    }
    listeners.forEach((l) => l());
  }, []);

  if (snoozed) return null;
  const months = Math.floor(days / 30);

  return (
    <section
      aria-label="Refresh your LinkedIn export"
      className="reveal-mount flex flex-col gap-3 rounded-2xl border border-warning/40 bg-card px-4 py-3 sm:flex-row sm:items-center"
    >
      <div className="flex min-w-0 flex-1 items-center gap-3">
        <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-warning/10 text-warning">
          <RefreshCw className="size-4" aria-hidden />
        </span>
        <p className="min-w-0 text-sm">
          <span className="font-medium text-ink">
            Your LinkedIn data is {months >= 2 ? `${months} months` : `${days} days`} old.
          </span>{" "}
          <span className="text-muted-foreground">
            Request a fresh export (it takes about a day), then upload it to bring in newer connections.
          </span>
        </p>
      </div>
      <div className="flex shrink-0 items-center gap-1.5">
        <a
          href={LINKEDIN_DATA_URL}
          target="_blank"
          rel="noopener noreferrer"
          className={cn(buttonVariants({ variant: "outline", size: "sm" }))}
        >
          <ExternalLink aria-hidden />
          Request export
        </a>
        <Link href="/imports#import-panel-connections" className={cn(buttonVariants({ size: "sm" }))}>
          Upload
        </Link>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          className="text-muted-foreground"
          onClick={snooze}
          aria-label="Hide the LinkedIn refresh reminder for two weeks"
        >
          <X aria-hidden />
        </Button>
      </div>
    </section>
  );
}
