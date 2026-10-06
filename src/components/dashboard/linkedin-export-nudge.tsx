"use client";

import { useCallback, useSyncExternalStore } from "react";
import Link from "next/link";
import { FileArchive, Search, X } from "lucide-react";
import { Button, buttonVariants } from "@/components/ui/button";
import { linkedInArchiveSearch } from "@/lib/inbox-search";
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
