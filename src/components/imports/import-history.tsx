"use client";

import { formatDistanceToNow } from "date-fns";
import {
  BookUser,
  Calendar as CalendarIcon,
  Contact,
  FileSpreadsheet,
  Mail,
  MessageSquare,
  Upload,
  type LucideIcon,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";

type SourceMeta = { label: string; icon: LucideIcon; badge: string };

const CONNECTIONS_BADGE = "bg-import-connections/10 text-import-connections";
const MESSAGES_BADGE = "bg-import-messages/10 text-import-messages";
const CALENDAR_BADGE = "bg-import-calendar/10 text-import-calendar";

/**
 * Every `imports.import_type` Orbit writes, with the name a person would call it.
 *
 * The row used to print the raw type (`google_contacts · 12 created`), and only the
 * LinkedIn and calendar types had an icon — so three of the ways into Orbit showed up in
 * history as a bare string. Colours follow the tab each import lives on in the hub:
 * contact imports share the Connections accent, whatever service they came from.
 */
const SOURCE_META: Record<string, SourceMeta> = {
  linkedin_connections: { label: "LinkedIn connections", icon: FileSpreadsheet, badge: CONNECTIONS_BADGE },
  contacts_file: { label: "Contacts file", icon: BookUser, badge: CONNECTIONS_BADGE },
  google_contacts: { label: "Google Contacts", icon: Contact, badge: CONNECTIONS_BADGE },
  outlook_contacts: { label: "Outlook Contacts", icon: Contact, badge: CONNECTIONS_BADGE },
  linkedin_messages: { label: "LinkedIn messages", icon: MessageSquare, badge: MESSAGES_BADGE },
  gmail_recruiter_scan: { label: "Gmail recruiter scan", icon: Mail, badge: MESSAGES_BADGE },
  calendar_ics: { label: "Calendar (.ics)", icon: CalendarIcon, badge: CALENDAR_BADGE },
  calendar_csv: { label: "Calendar (CSV)", icon: CalendarIcon, badge: CALENDAR_BADGE },
};

/** A type this list has never heard of still gets a row that looks like the others. */
const UNKNOWN_SOURCE: SourceMeta = {
  label: "Import",
  icon: Upload,
  badge: "bg-muted text-muted-foreground",
};

const STATUS_LABEL: Record<string, string> = {
  processing: "In progress",
  pending: "Waiting",
  completed: "Done",
  failed: "Didn’t finish",
  cancelled: "Cancelled",
};

function statusLabel(status: string) {
  return STATUS_LABEL[status] ?? status.charAt(0).toUpperCase() + status.slice(1);
}

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
          Every import on this account, newest first — LinkedIn, contacts files,
          Google, Outlook and calendars.
        </p>
      </div>

      {history.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No imports yet. Upload a LinkedIn export or a contacts file above,
          connect Google or Outlook, or sync a calendar to get started.
        </p>
      ) : (
        <ul className="space-y-2">
          {history.map((h) => {
            const meta = (h.importType && SOURCE_META[h.importType]) || UNKNOWN_SOURCE;
            const Icon = meta.icon;
            const title = h.fileName || meta.label;
            return (
              <li
                key={h.id}
                className="flex items-center justify-between gap-3 rounded-xl border border-border/60 bg-background/60 px-4 py-3 text-sm"
              >
                <div className="flex min-w-0 items-start gap-3">
                  <span
                    className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-lg ${meta.badge}`}
                  >
                    <Icon className="h-3.5 w-3.5" aria-hidden />
                  </span>
                  <div className="min-w-0">
                    <p className="truncate font-medium text-ink">{title}</p>
                    <p className="text-xs text-muted-foreground">
                      {/* Google and Outlook imports are named after their service, so the
                          label would only repeat the title. */}
                      {meta.label !== title ? `${meta.label} · ` : ""}
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
                  className="shrink-0"
                >
                  {statusLabel(h.status)}
                </Badge>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
