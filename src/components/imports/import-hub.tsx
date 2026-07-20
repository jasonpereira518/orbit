"use client";

import { useState } from "react";
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

export function ImportHub({
  history,
  calendarSubscriptions = [],
}: {
  history: ImportHistoryItem[];
  calendarSubscriptions?: CalendarSub[];
}) {
  const [tab, setTab] = useState<ImportTab>("connections");

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

      {tab === "connections" ? <LinkedInConnectionsImport /> : null}
      {tab === "messages" ? <LinkedInMessagesImport /> : null}
      {tab === "calendar" ? (
        <CalendarImportSection calendarSubscriptions={calendarSubscriptions} />
      ) : null}

      <ImportHistory history={history} />
    </div>
  );
}
