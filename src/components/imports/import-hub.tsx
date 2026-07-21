"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { CalendarImportSection } from "@/components/imports/calendar-import-section";
import {
  ImportHistory,
  type ImportHistoryItem,
} from "@/components/imports/import-history";
import { LinkedInConnectionsImport } from "@/components/imports/linkedin-connections-import";
import { LinkedInMessagesImport } from "@/components/imports/linkedin-messages-import";
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

/** Refresh server-rendered data when the user returns to this browser tab. */
function useRefreshOnVisible() {
  const router = useRouter();

  useEffect(() => {
    function onVisible() {
      if (document.visibilityState === "visible") {
        router.refresh();
      }
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
  const [tab, setTab] = useState<ImportTab>("connections");
  useRefreshOnVisible();

  return (
    <div className="space-y-8">
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
          </button>
        ))}
      </div>

      {/* Keep panels mounted so in-flight imports survive tab switches. */}
      <div
        id="import-panel-connections"
        role="tabpanel"
        aria-labelledby="import-tab-connections"
        hidden={tab !== "connections"}
      >
        <LinkedInConnectionsImport />
      </div>
      <div
        id="import-panel-messages"
        role="tabpanel"
        aria-labelledby="import-tab-messages"
        hidden={tab !== "messages"}
      >
        <LinkedInMessagesImport />
      </div>
      <div
        id="import-panel-calendar"
        role="tabpanel"
        aria-labelledby="import-tab-calendar"
        hidden={tab !== "calendar"}
      >
        <CalendarImportSection calendarSubscriptions={calendarSubscriptions} />
      </div>

      <ImportHistory history={history} />
    </div>
  );
}
