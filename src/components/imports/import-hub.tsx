"use client";

import dynamic from "next/dynamic";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import {
  ImportHistory,
  type ImportHistoryItem,
} from "@/components/imports/import-history";
import { ImportProgress } from "@/components/imports/import-utils";
import { Skeleton } from "@/components/ui/skeleton";
import { cancelImportJob, useImportJob } from "@/lib/import-job-runner";
import { cn } from "@/lib/utils";

type ImportTab = "connections" | "messages" | "calendar";

type CalendarSub = {
  id: string;
  label: string | null;
  icsUrl: string;
  selfEmail: string | null;
  enabled: number;
  lastSyncedAt: Date | string | null;
  lastSyncStatus: string | null;
  lastSyncError: string | null;
  lastSyncStats: {
    scanned?: number;
    matched?: number;
    created?: number;
    updated?: number;
    contactsCreated?: number;
  } | null;
};

const TABS: { id: ImportTab; label: string }[] = [
  { id: "connections", label: "Connections" },
  { id: "messages", label: "Messages" },
  { id: "calendar", label: "Calendar" },
];

const PanelSkeleton = () => (
  <div className="space-y-3 rounded-xl border border-border/60 p-4">
    <Skeleton className="h-5 w-40" />
    <Skeleton className="h-24 w-full" />
    <Skeleton className="h-9 w-32" />
  </div>
);

const LinkedInConnectionsImport = dynamic(
  () =>
    import("@/components/imports/linkedin-connections-import").then((m) => ({
      default: m.LinkedInConnectionsImport,
    })),
  { loading: () => <PanelSkeleton /> }
);

const LinkedInMessagesImport = dynamic(
  () =>
    import("@/components/imports/linkedin-messages-import").then((m) => ({
      default: m.LinkedInMessagesImport,
    })),
  { loading: () => <PanelSkeleton /> }
);

const CalendarImportSection = dynamic(
  () =>
    import("@/components/imports/calendar-import-section").then((m) => ({
      default: m.CalendarImportSection,
    })),
  { loading: () => <PanelSkeleton /> }
);

/** Refresh server-rendered data when the user returns to this browser tab. */
function useRefreshOnVisible() {
  const router = useRouter();

  useEffect(() => {
    let lastRefresh = 0;
    function onVisible() {
      if (document.visibilityState !== "visible") return;
      // visibilitychange + focus often fire together; coalesce into one refresh.
      const now = Date.now();
      if (now - lastRefresh < 500) return;
      lastRefresh = now;
      router.refresh();
    }

    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onVisible);
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", onVisible);
    };
  }, [router]);
}

export function ImportHub({
  history,
  calendarSubscriptions = [],
}: {
  history: ImportHistoryItem[];
  calendarSubscriptions?: CalendarSub[];
}) {
  const job = useImportJob();
  const [tab, setTab] = useState<ImportTab>("connections");
  // Mount panels on first visit so inactive tabs don't load code upfront,
  // but keep them mounted afterward so in-flight imports survive switches.
  const [mounted, setMounted] = useState<Record<ImportTab, boolean>>({
    connections: true,
    messages: false,
    calendar: false,
  });
  useRefreshOnVisible();

  useEffect(() => {
    setMounted((prev) => (prev[tab] ? prev : { ...prev, [tab]: true }));
  }, [tab]);

  // When returning mid-import, open the relevant tab and show progress.
  useEffect(() => {
    if (job?.status !== "running") return;
    if (job.kind !== "connections" && job.kind !== "messages") return;
    setTab(job.kind);
    setMounted((prev) =>
      prev[job.kind] ? prev : { ...prev, [job.kind]: true }
    );
  }, [job]);

  const runningProgress =
    job?.status === "running" && job.progress ? job.progress : null;

  return (
    <div className="space-y-8">
      {runningProgress ? (
        <ImportProgress
          {...runningProgress}
          cancelling={Boolean(job?.cancelling)}
          onCancel={cancelImportJob}
        />
      ) : null}

      <div
        className="flex gap-1 rounded-xl border border-border/60 bg-muted/40 p-1"
        role="tablist"
        aria-label="Import type"
      >
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={tab === t.id}
            aria-controls={`import-panel-${t.id}`}
            id={`import-tab-${t.id}`}
            onClick={() => setTab(t.id)}
            className={cn(
              "flex-1 rounded-lg px-3 py-2 text-sm font-medium transition-colors",
              tab === t.id
                ? "bg-card text-primary shadow-sm"
                : "text-muted-foreground hover:text-foreground"
            )}
          >
            {t.label}
            {job?.status === "running" && job.kind === t.id ? " ·…" : ""}
          </button>
        ))}
      </div>

      {mounted.connections && (
        <div
          id="import-panel-connections"
          role="tabpanel"
          aria-labelledby="import-tab-connections"
          hidden={tab !== "connections"}
        >
          <LinkedInConnectionsImport />
        </div>
      )}
      {mounted.messages && (
        <div
          id="import-panel-messages"
          role="tabpanel"
          aria-labelledby="import-tab-messages"
          hidden={tab !== "messages"}
        >
          <LinkedInMessagesImport />
        </div>
      )}
      {mounted.calendar && (
        <div
          id="import-panel-calendar"
          role="tabpanel"
          aria-labelledby="import-tab-calendar"
          hidden={tab !== "calendar"}
        >
          <CalendarImportSection calendarSubscriptions={calendarSubscriptions} />
        </div>
      )}

      <ImportHistory history={history} />
    </div>
  );
}
