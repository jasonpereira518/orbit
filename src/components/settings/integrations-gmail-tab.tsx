"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Lock } from "lucide-react";
import {
  getGmailConnectionStatus,
  getGmailScanStatus,
  type GmailConnectionStatus,
  type GmailScanStatus,
} from "@/actions/gmail";
import { buttonVariants } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { GmailImportPanel } from "@/components/recruiters/gmail-import-panel";
import { SettingsSection } from "@/components/settings/settings-section";
import { cn } from "@/lib/utils";

type Loaded = { connection: GmailConnectionStatus; scan: GmailScanStatus | null };

/**
 * The Gmail recruiter scan, as a tab of Settings → Integrations.
 *
 * /recruiters fetches the panel's two inputs on the server; here they load when the tab
 * first opens, since most visits to Settings never open it. Recruiters is a paid feature —
 * the page shows `RecruitersLocked` — so a free account gets a short note here instead of
 * a Connect button whose scan the server would refuse.
 */
export function GmailTab({
  active,
  canUseRecruiters,
  returnTo,
}: {
  active: boolean;
  canUseRecruiters: boolean;
  returnTo: string;
}) {
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);

  // Google's consent screen comes back with `google` and `gmail` set to connected or error,
  // and the Google Contacts card on this page strips both as it mounts. Next patches
  // `history.replaceState` into a router "restore", and a restore that lands while a server
  // action is queued drops that action without ever settling it — so this waits for the
  // strip before loading (the restore updates `useSearchParams`, which re-runs the load),
  // and asks once more if a load still hasn't answered after 6s. The panel below then mounts
  // with the params already gone, so it never strips them itself.
  const google = useSearchParams().get("google");
  const awaitingStrip = google === "connected" || google === "error";

  useEffect(() => {
    if (!canUseRecruiters || awaitingStrip) return;
    let cancelled = false;
    let settled = false;
    const load = () =>
      Promise.all([getGmailConnectionStatus(), getGmailScanStatus()]).then(
        ([connection, scan]) => {
          if (cancelled || settled) return;
          settled = true;
          setLoaded({ connection, scan });
        },
        () => {
          if (cancelled || settled) return;
          settled = true;
          setFailed(true);
        }
      );
    void load();
    const retry = window.setTimeout(() => {
      if (!settled) void load();
    }, 6_000);
    // Neither answered: offer Try again rather than a skeleton. A late answer still lands.
    const giveUp = window.setTimeout(() => {
      if (!cancelled && !settled) setFailed(true);
    }, 12_000);
    return () => {
      cancelled = true;
      window.clearTimeout(retry);
      window.clearTimeout(giveUp);
    };
  }, [canUseRecruiters, awaitingStrip, attempt]);

  if (!canUseRecruiters) {
    return (
      <SettingsSection
        title="Gmail"
        description="Search your whole mailbox for recruiters, the companies they hired for, and a summary of every conversation."
      >
        <div className="flex flex-wrap items-center gap-3 rounded-xl bg-muted/40 p-4 text-sm text-muted-foreground">
          <Lock className="size-4 shrink-0" aria-hidden />
          <p className="min-w-0 flex-1">The recruiter scan is part of Orbit Pro.</p>
          <Link href="/pricing" className={cn(buttonVariants({ size: "sm" }))}>
            See plans
          </Link>
        </div>
      </SettingsSection>
    );
  }

  if (failed && !loaded) {
    return (
      <div className="space-y-2 text-sm">
        <p className="text-muted-foreground">Couldn’t load your Gmail connection.</p>
        <button
          type="button"
          className={cn(buttonVariants({ size: "sm", variant: "outline" }))}
          onClick={() => {
            setFailed(false);
            setAttempt((n) => n + 1);
          }}
        >
          Try again
        </button>
      </div>
    );
  }

  if (!loaded) {
    return (
      <div className="space-y-3" aria-busy="true" aria-label="Loading Gmail">
        <Skeleton className="h-6 w-24" />
        <Skeleton className="h-4 w-3/4" />
        <Skeleton className="h-9 w-32 rounded-lg" />
      </div>
    );
  }

  // The panel polls a running scan every two seconds; it must stop the moment the dialog
  // starts closing rather than when Base UI eventually unmounts it.
  if (!active) return null;

  // Unconfigured, the panel is a bare note that leans on /recruiters' own heading.
  if (!loaded.connection.configured) {
    return (
      <SettingsSection title="Gmail">
        <GmailImportPanel connection={loaded.connection} initialScan={loaded.scan} />
      </SettingsSection>
    );
  }

  return (
    <GmailImportPanel
      connection={loaded.connection}
      initialScan={loaded.scan}
      returnTo={returnTo}
    />
  );
}
