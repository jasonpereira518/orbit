"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "@/lib/toast";
import {
  previewCalendarImport,
  confirmCalendarImport,
} from "@/actions/imports";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { CalendarSubscribePanel } from "@/components/imports/calendar-subscribe-panel";
import {
  BusyHint,
  CALENDAR_BATCH_SIZE,
  ImportFilePicker,
  ImportProgress,
  type ImportProgressState,
} from "@/components/imports/import-utils";

type CalendarPreview = Awaited<ReturnType<typeof previewCalendarImport>>;

export type CalendarSub = {
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

export function CalendarImportSection({
  calendarSubscriptions = [],
}: {
  calendarSubscriptions?: CalendarSub[];
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [importProgress, setImportProgress] =
    useState<ImportProgressState | null>(null);

  const [calendarText, setCalendarText] = useState("");
  const [calendarKind, setCalendarKind] = useState<"ics" | "csv">("ics");
  const [calendarFileName, setCalendarFileName] = useState<string | null>(null);
  const [calendarPreview, setCalendarPreview] =
    useState<CalendarPreview | null>(null);
  const [createFollowUps, setCreateFollowUps] = useState(true);

  const busy = pending || importProgress !== null;

  return (
    <div className="space-y-6">
      <CalendarSubscribePanel initialSubscriptions={calendarSubscriptions} />

      <section className="space-y-4 rounded-2xl border border-border/70 bg-card p-6">
        <div>
          <h2 className="text-lg font-medium text-primary">
            One-time calendar upload
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Export an ICS or CSV from Google, Apple, or Outlook. Orbit matches
            attendees to contacts already in your network and logs those
            meetings — it does not create new contacts from a one-time upload.
            Use a calendar subscription above if you want Orbit to create
            contacts from 1:1s.
          </p>
        </div>
        <ImportFilePicker
          accept=".ics,.csv,text/calendar,text/csv"
          disabled={busy}
          fileName={calendarFileName}
          onFile={async (file) => {
            const lower = file.name.toLowerCase();
            setCalendarKind(lower.endsWith(".csv") ? "csv" : "ics");
            setCalendarFileName(file.name);
            setCalendarText(await file.text());
            setCalendarPreview(null);
          }}
        />
        <label className="flex items-center gap-2 text-sm text-muted-foreground">
          <input
            type="checkbox"
            checked={createFollowUps}
            onChange={(e) => setCreateFollowUps(e.target.checked)}
            disabled={busy}
          />
          Create follow-up reminders for recent past meetings
        </label>
        {pending && !importProgress ? <BusyHint>Working…</BusyHint> : null}
        {importProgress ? <ImportProgress {...importProgress} /> : null}
        <div className="flex gap-2">
          <Button
            disabled={!calendarText || busy}
            variant="outline"
            onClick={() =>
              start(async () => {
                try {
                  const res = await previewCalendarImport({
                    kind: calendarKind,
                    text: calendarText,
                  });
                  setCalendarPreview(res);
                  toast.success(
                    `${res.windowedEvents} events in window · ${res.matchedEventCount} with matches`
                  );
                } catch (err) {
                  toast.error(
                    err instanceof Error ? err.message : "Preview failed"
                  );
                }
              })
            }
          >
            Preview
          </Button>
          <Button
            disabled={!calendarText || busy}
            className="bg-primary text-primary-foreground hover:bg-primary/90"
            onClick={async () => {
              if (busy) return;
              try {
                let importId: string | undefined;
                let offset = 0;
                let total = 0;
                let meetingsLogged = 0;
                let contactsMatched = 0;

                setImportProgress({
                  done: 0,
                  total: 1,
                  label: "events",
                });

                do {
                  const res = await confirmCalendarImport({
                    kind: calendarKind,
                    text: calendarText,
                    fileName: calendarFileName || "calendar.ics",
                    createFollowUps,
                    importId,
                    finalize: false,
                    chunk: {
                      offset,
                      limit: CALENDAR_BATCH_SIZE,
                    },
                  });
                  importId = res.importId;
                  total = res.totalWindowed;
                  meetingsLogged += res.meetingsLogged;
                  contactsMatched += res.contactsMatched;
                  offset += res.eventsProcessed;
                  setImportProgress({
                    done: Math.min(offset, Math.max(total, 1)),
                    total: Math.max(total, 1),
                    label: total === 1 ? "event" : "events",
                  });
                } while (offset < total);

                await confirmCalendarImport({
                  kind: calendarKind,
                  text: calendarText,
                  fileName: calendarFileName || "calendar.ics",
                  createFollowUps,
                  importId,
                  finalize: true,
                  chunk: { offset: total, limit: 0 },
                });

                toast.success(
                  `Logged ${meetingsLogged} meetings across ${contactsMatched} contacts`
                );
                setCalendarPreview(null);
                setCalendarText("");
                setCalendarFileName(null);
                router.refresh();
              } catch (err) {
                toast.error(
                  err instanceof Error ? err.message : "Import failed"
                );
              } finally {
                setImportProgress(null);
              }
            }}
          >
            {importProgress
              ? `Importing… ${importProgress.done}/${importProgress.total}`
              : "Confirm import"}
          </Button>
        </div>

        {calendarPreview && (
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">
              {calendarPreview.totalEvents} events ·{" "}
              {calendarPreview.windowedEvents} in last 180 days / next 14 ·{" "}
              {calendarPreview.matchedEventCount} with contact matches
            </p>
            <div className="max-h-80 overflow-auto rounded-xl border border-border/60">
              <table className="w-full text-left text-sm">
                <thead className="bg-muted/50 text-xs">
                  <tr>
                    <th className="px-3 py-2">Event</th>
                    <th className="px-3 py-2">When</th>
                    <th className="px-3 py-2">Matches</th>
                  </tr>
                </thead>
                <tbody>
                  {calendarPreview.preview.map((row) => (
                    <tr key={row.uid} className="border-t border-border/50">
                      <td className="px-3 py-2">{row.summary}</td>
                      <td className="px-3 py-2 text-muted-foreground">
                        {row.start
                          ? new Date(row.start).toLocaleDateString()
                          : "—"}
                      </td>
                      <td className="px-3 py-2">
                        {row.matchedContacts > 0 ? (
                          <Badge variant="secondary">
                            {row.matchedContacts} contact
                            {row.matchedContacts > 1 ? "s" : ""}
                          </Badge>
                        ) : (
                          <span className="text-muted-foreground">None</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </section>
    </div>
  );
}
