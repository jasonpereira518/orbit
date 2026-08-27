"use client";

import { formatDistanceToNow } from "date-fns";
import {
  Calendar as CalendarIcon,
  FileSpreadsheet,
  MessageSquare,
  type LucideIcon,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";

const SOURCE_META: Record<string, { icon: LucideIcon; badge: string }> = {
  linkedin_connections: {
    icon: FileSpreadsheet,
    badge: "bg-import-connections/10 text-import-connections",
  },
  linkedin_messages: {
    icon: MessageSquare,
    badge: "bg-import-messages/10 text-import-messages",
  },
  calendar_ics: {
    icon: CalendarIcon,
    badge: "bg-import-calendar/10 text-import-calendar",
  },
  calendar_csv: {
    icon: CalendarIcon,
    badge: "bg-import-calendar/10 text-import-calendar",
  },
};

export type ImportHistoryItem = {
  id: string;
  fileName: string | null;
  importType?: string | null;
  status: string;
  contactsCreated: number | null;
  contactsUpdated: number | null;
  duplicatesFound: number | null;
  rowsProcessed?: number | null;
  errorMessage?: string | null;
  stats?: {
    skipped?: number;
    // Legacy per-type breakdown: written by import types before they moved onto the
    // resumable engine, and no longer written by anything — kept here purely so historical
    // rows from before that move still render their real counts instead of going blank.
    messagesImported?: number;
    meetingsLogged?: number;
    // Current, adapter-agnostic counters every server-owned import job's engine run writes
    // (see `ImportStats` in `src/db/schema.ts`) — what `messagesImported`/`meetingsLogged`
    // were replaced by once LinkedIn messages (Task 14) and calendar (Task 15) moved onto
    // the engine, which counts interactions/reminders once generically instead of per type.
    interactionsLogged?: number;
    remindersCreated?: number;
    /** Rows the engine isolated as unwritable — see `ImportStats.failedRows`. */
    failedRows?: number;
    contactsEnriched?: number;
    eventsProcessed?: number;
  } | null;
  createdAt: Date | string;
};

export function ImportHistory({ history }: { history: ImportHistoryItem[] }) {
  return (
    <section className="space-y-4 rounded-2xl border border-border/70 bg-card p-6">
      <div>
        <h2 className="text-lg font-medium text-ink">Import history</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Recent LinkedIn and calendar imports for this account.
        </p>
      </div>

      {history.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No imports yet. Upload a LinkedIn Connections or Messages file above,
          or sync a calendar to get started.
        </p>
      ) : (
        <ul className="space-y-2">
          {history.map((h) => {
            const meta = h.importType ? SOURCE_META[h.importType] : null;
            const Icon = meta?.icon;
            return (
              <li
                key={h.id}
                className="flex items-center justify-between gap-3 rounded-xl border border-border/60 bg-background/60 px-4 py-3 text-sm"
              >
                <div className="flex min-w-0 items-start gap-3">
                  {Icon ? (
                    <span
                      className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-lg ${meta.badge}`}
                    >
                      <Icon className="h-3.5 w-3.5" />
                    </span>
                  ) : null}
                  <div className="min-w-0">
                    <p className="font-medium text-ink">
                      {h.fileName || "Import"}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {h.importType ? `${h.importType} · ` : ""}
                      {h.contactsCreated ?? 0} created ·{" "}
                      {h.contactsUpdated ?? 0} updated
                      {h.stats?.messagesImported
                        ? ` · ${h.stats.messagesImported} messages`
                        : ""}
                      {h.stats?.meetingsLogged
                        ? ` · ${h.stats.meetingsLogged} meetings`
                        : ""}
                      {h.stats?.interactionsLogged
                        ? ` · ${h.stats.interactionsLogged} interactions logged`
                        : ""}
                      {h.stats?.remindersCreated
                        ? ` · ${h.stats.remindersCreated} reminders`
                        : ""}
                      {h.duplicatesFound
                        ? ` · ${h.duplicatesFound} duplicates`
                        : ""}
                      {h.stats?.skipped ? ` · ${h.stats.skipped} skipped` : ""}
                      {h.stats?.failedRows ? ` · ${h.stats.failedRows} failed` : ""}
                    </p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {formatDistanceToNow(new Date(h.createdAt), {
                        addSuffix: true,
                      })}
                    </p>
                    {h.errorMessage ? (
                      <p className="mt-1 text-xs text-destructive">
                        {h.errorMessage}
                      </p>
                    ) : null}
                  </div>
                </div>
                <Badge
                  variant={
                    h.status === "failed"
                      ? "destructive"
                      : h.status === "processing" || h.status === "cancelled"
                        ? "secondary"
                        : "outline"
                  }
                >
                  {h.status}
                </Badge>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
