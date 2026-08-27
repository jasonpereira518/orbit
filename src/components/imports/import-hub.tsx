"use client";

import dynamic from "next/dynamic";
import Link from "next/link";
import { useEffect, useState } from "react";
import { motion } from "motion/react";
import {
  Calendar as CalendarIcon,
  FileSpreadsheet,
  MessageSquare,
  NotebookPen,
} from "lucide-react";
import {
  ImportHistory,
  type ImportHistoryItem,
} from "@/components/imports/import-history";
import { ImportProgress } from "@/components/imports/import-utils";
import { Skeleton } from "@/components/ui/skeleton";
import {
  cancelImportJob,
  useImportJob,
  type ImportJobKind,
} from "@/lib/import-job-runner";
import { LockedFeature } from "@/components/locked-feature";
import { SPRING_PILL } from "@/lib/motion";
import { useRefreshOnVisible } from "@/lib/use-refresh-on-visible";
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

const TABS: {
  id: ImportTab;
  label: string;
  icon: typeof FileSpreadsheet;
  activeText: string;
}[] = [
  {
    id: "connections",
    label: "Connections",
    icon: FileSpreadsheet,
    activeText: "text-import-connections",
  },
  {
    id: "messages",
    label: "Messages",
    icon: MessageSquare,
    activeText: "text-import-messages",
  },
  {
    id: "calendar",
    label: "Calendar",
    icon: CalendarIcon,
    activeText: "text-import-calendar",
  },
];

/**
 * Which tab an in-flight import job belongs to. Google/Outlook contacts imports render
 * inside the "connections" tab alongside LinkedIn connections (see the panel below), so
 * both map there rather than getting their own tab. `null` for kinds this hub doesn't
 * surface a tab for.
 */
function tabForImportJobKind(kind: ImportJobKind): ImportTab | null {
  switch (kind) {
    case "connections":
    case "google_contacts":
    case "outlook_contacts":
      return "connections";
    case "messages":
      return "messages";
  }
}

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
  { loading: () => <PanelSkeleton /> },
);

const GoogleContactsImport = dynamic(
  () =>
    import("@/components/imports/google-contacts-import").then((m) => ({
      default: m.GoogleContactsImport,
    })),
  { loading: () => <PanelSkeleton /> }
);

const OutlookContactsImport = dynamic(
  () =>
    import("@/components/imports/outlook-contacts-import").then((m) => ({
      default: m.OutlookContactsImport,
    })),
  { loading: () => <PanelSkeleton /> }
);

const LinkedInMessagesImport = dynamic(
  () =>
    import("@/components/imports/linkedin-messages-import").then((m) => ({
      default: m.LinkedInMessagesImport,
    })),
  { loading: () => <PanelSkeleton /> },
);

const CalendarImportSection = dynamic(
  () =>
    import("@/components/imports/calendar-import-section").then((m) => ({
      default: m.CalendarImportSection,
    })),
  { loading: () => <PanelSkeleton /> },
);

export function ImportHub({
  history,
  calendarSubscriptions = [],
  canUseSync = true,
}: {
  history: ImportHistoryItem[];
  calendarSubscriptions?: CalendarSub[];
  /** Calendar sync is a paid feature; LinkedIn import stays free on every plan. */
  canUseSync?: boolean;
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

  // When returning mid-import, open the relevant tab and show progress. Google/Outlook
  // contacts imports render inside the "connections" tab alongside LinkedIn connections
  // (see the panel below), so both map there rather than getting their own tab.
  useEffect(() => {
    if (job?.status !== "running") return;
    const targetTab = tabForImportJobKind(job.kind);
    if (!targetTab) return;
    setTab(targetTab);
    setMounted((prev) => (prev[targetTab] ? prev : { ...prev, [targetTab]: true }));
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
        className="relative flex gap-1 rounded-xl border border-border/60 bg-muted/40 p-1"
        role="tablist"
        aria-label="Import type"
      >
        {TABS.map((t) => {
          const active = tab === t.id;
          const Icon = t.icon;
          return (
            <button
              key={t.id}
              type="button"
              role="tab"
              aria-selected={active}
              aria-controls={`import-panel-${t.id}`}
              id={`import-tab-${t.id}`}
              onClick={() => setTab(t.id)}
              className={cn(
                "relative z-10 flex flex-1 items-center justify-center gap-1.5 rounded-lg px-3 py-2 text-sm font-medium transition-colors",
                active
                  ? t.activeText
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {active ? (
                <motion.span
                  layoutId="import-tab-pill"
                  className="absolute inset-0 rounded-lg bg-card shadow-sm ring-1 ring-black/[0.04] dark:ring-white/10"
                  transition={SPRING_PILL}
                />
              ) : null}
              <Icon
                className={cn(
                  "relative z-10 h-3.5 w-3.5",
                  !active && "text-muted-foreground/70",
                )}
              />
              <span className="relative z-10">
                {t.label}
                {job?.status === "running" && tabForImportJobKind(job.kind) === t.id
                  ? " ·…"
                  : ""}
              </span>
            </button>
          );
        })}
      </div>

      {mounted.connections && (
        <div
          id="import-panel-connections"
          role="tabpanel"
          aria-labelledby="import-tab-connections"
          hidden={tab !== "connections"}
          className="space-y-6"
        >
          <LinkedInConnectionsImport />
          <GoogleContactsImport />
          <OutlookContactsImport />
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
          {canUseSync ? (
            <CalendarImportSection
              calendarSubscriptions={calendarSubscriptions}
            />
          ) : (
            <LockedFeature
              title="Calendar sync"
              description="Point Orbit at your calendar and it turns meetings into logged interactions, so your follow-ups stay current without any typing."
              highlights={[
                "Subscribe to a calendar once and keep it in sync",
                "Networking meetings become logged interactions",
                "New people from invites land in your contacts",
                "Follow-up reminders created automatically",
              ]}
              note="LinkedIn imports stay free on every plan."
            />
          )}
        </div>
      )}

      {/* Notes live in Capture rather than as a tab here, so there's exactly one
          extraction path — but this is where people look for them. */}
      <Link
        href="/capture"
        className="flex items-start gap-3 rounded-2xl border border-border/70 bg-card p-5 transition-colors hover:border-primary/40"
      >
        <NotebookPen className="mt-0.5 size-5 shrink-0 text-primary" />
        <span className="space-y-1">
          <span className="block text-sm font-medium text-foreground">
            Meeting &amp; chat notes
          </span>
          <span className="block text-sm text-muted-foreground">
            Paste or upload your notes and Orbit pulls out the people — plus any
            dates you wrote down, as reminders you review before they&apos;re set.
          </span>
        </span>
      </Link>

      <ImportHistory history={history} />
    </div>
  );
}
