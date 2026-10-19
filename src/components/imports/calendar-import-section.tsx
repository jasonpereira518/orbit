"use client";

import { useEffect, useState, useTransition } from "react";
import { toast } from "@/lib/toast";
import { previewCalendarImport } from "@/actions/imports";
import { CALENDAR_BACKFILL_DAYS } from "@/lib/calendar-import";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { CalendarSubscribePanel } from "@/components/imports/calendar-subscribe-panel";
import {
  BusyHint,
  ImportFilePicker,
  ImportProgress,
} from "@/components/imports/import-utils";
import { startImportJob, useImportJob } from "@/lib/import-job-runner";
import { fitsInOneRequest } from "@/lib/capture-limits";
import { friendlyError } from "@/lib/errors";
import { IMPORT_COPY } from "@/lib/imports/import-copy";
import { TOAST_COPY } from "@/lib/toast-copy";

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
  const job = useImportJob();
  const [pending, start] = useTransition();

  const [calendarText, setCalendarText] = useState("");
  const [calendarKind, setCalendarKind] = useState<"ics" | "csv">("ics");
  const [calendarFileName, setCalendarFileName] = useState<string | null>(null);
  const [calendarPreview, setCalendarPreview] =
    useState<CalendarPreview | null>(null);
  const [createFollowUps, setCreateFollowUps] = useState(true);

  const calendarJob =
    job?.kind === "calendar" && job.status === "running" ? job : null;
  const importProgress = calendarJob?.progress ?? null;
  const busy = pending || job?.status === "running";

  // Clear local review UI once this job finishes — toasts are handled globally by
  // ImportJobWatcher, same as every other import section on the poll flow.
  useEffect(() => {
    if (!job || job.kind !== "calendar") return;
    if (
      job.status !== "completed" &&
      job.status !== "failed" &&
      job.status !== "cancelled"
    )
      return;
    queueMicrotask(() => {
      setCalendarPreview(null);
      setCalendarText("");
      setCalendarFileName(null);
    });
  }, [job]);

  return (
    <div className="space-y-6">
      <CalendarSubscribePanel initialSubscriptions={calendarSubscriptions} />

      <section className="space-y-4 border-t border-border-subtle pt-6">
        <div className="flex items-start gap-3">
          <div className="min-w-0">
            <h3 className="text-sm font-medium text-ink">One-time calendar upload</h3>
            <p className="mt-1 text-sm text-muted-foreground">
              Export an ICS or CSV from Google, Apple, or Outlook. Orbit matches
              attendees to contacts already in your network and logs those
              meetings — it does not create new contacts from a one-time upload.
              Use a calendar subscription above if you want Orbit to create
              contacts from 1:1s.
            </p>
          </div>
        </div>
        <ImportFilePicker
          accept=".ics,.csv,text/calendar,text/csv"
          disabled={busy}
          fileName={calendarFileName}
          onFile={async (file) => {
            const lower = file.name.toLowerCase();
            const text = await file.text();
            if (!fitsInOneRequest(text)) {
              toast.error(IMPORT_COPY.tooLarge);
              return;
            }
            setCalendarKind(lower.endsWith(".csv") ? "csv" : "ics");
            setCalendarFileName(file.name);
            setCalendarText(text);
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
                    `${res.windowedEvents} events in window · ${res.matchedEventCount} with matches`,
                  );
                } catch (err) {
                  toast.error(friendlyError(err, TOAST_COPY.previewFailed));
                }
              })
            }
          >
            Preview
          </Button>
          <Button
            disabled={!calendarText || busy}
            onClick={() => {
              if (busy) return;
              try {
                startImportJob({
                  kind: "calendar",
                  calendarKind,
                  text: calendarText,
                  fileName: calendarFileName || "calendar.ics",
                  createFollowUps,
                });
                // Clear the review list immediately; progress lives in the runner.
                setCalendarPreview(null);
                setCalendarText("");
                setCalendarFileName(null);
              } catch (err) {
                toast.error(friendlyError(err, TOAST_COPY.importFailed));
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
              {calendarPreview.windowedEvents} in last{" "}
              {Math.round(CALENDAR_BACKFILL_DAYS / 365)} years / next 14 ·{" "}
              {calendarPreview.matchedEventCount} with contact matches
            </p>
            <div className="max-h-80 overflow-auto rounded-xl border border-border-subtle">
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
