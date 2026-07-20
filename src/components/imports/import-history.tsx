"use client";

import { formatDistanceToNow } from "date-fns";
import { Badge } from "@/components/ui/badge";

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
    messagesImported?: number;
    meetingsLogged?: number;
    remindersCreated?: number;
    contactsEnriched?: number;
    eventsProcessed?: number;
  } | null;
  createdAt: Date | string;
};

export function ImportHistory({ history }: { history: ImportHistoryItem[] }) {
  return (
    <section className="space-y-4 rounded-2xl border border-border/70 bg-card p-6">
      <div>
        <h2 className="text-lg font-medium text-primary">Import history</h2>
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
          {history.map((h) => (
            <li
              key={h.id}
              className="flex items-center justify-between gap-3 rounded-xl border border-border/60 bg-background/60 px-4 py-3 text-sm"
            >
              <div className="min-w-0">
                <p className="font-medium text-primary">
                  {h.fileName || "Import"}
                </p>
                <p className="text-xs text-muted-foreground">
                  {h.importType ? `${h.importType} · ` : ""}
                  {h.contactsCreated ?? 0} created · {h.contactsUpdated ?? 0}{" "}
                  updated
                  {h.stats?.messagesImported
                    ? ` · ${h.stats.messagesImported} messages`
                    : ""}
                  {h.stats?.meetingsLogged
                    ? ` · ${h.stats.meetingsLogged} meetings`
                    : ""}
                  {h.duplicatesFound
                    ? ` · ${h.duplicatesFound} duplicates`
                    : ""}
                  {h.stats?.skipped ? ` · ${h.stats.skipped} skipped` : ""}
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
              <Badge
                variant={
                  h.status === "failed"
                    ? "destructive"
                    : h.status === "processing"
                      ? "secondary"
                      : "outline"
                }
              >
                {h.status}
              </Badge>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
