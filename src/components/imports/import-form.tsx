"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";
import JSZip from "jszip";
import {
  previewLinkedInCsv,
  confirmLinkedInImport,
  previewLinkedInMessagesCsv,
  confirmLinkedInMessagesImport,
  previewCalendarImport,
  confirmCalendarImport,
} from "@/actions/imports";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

type Tab = "connections" | "messages" | "calendar";

type ConnectionsPreview = Awaited<ReturnType<typeof previewLinkedInCsv>>;
type MessagesPreview = Awaited<ReturnType<typeof previewLinkedInMessagesCsv>>;
type CalendarPreview = Awaited<ReturnType<typeof previewCalendarImport>>;

async function readCsvOrZipMessages(file: File): Promise<{
  text: string;
  fileName: string;
}> {
  const lower = file.name.toLowerCase();
  if (lower.endsWith(".zip")) {
    const zip = await JSZip.loadAsync(await file.arrayBuffer());
    const entry =
      zip.file(/messages\.csv$/i)[0] ||
      Object.values(zip.files).find(
        (f) => !f.dir && /messages\.csv$/i.test(f.name)
      );
    if (!entry) {
      throw new Error("No messages.csv found in ZIP. Export Messages from LinkedIn.");
    }
    const text = await entry.async("string");
    return { text, fileName: entry.name.split("/").pop() || "messages.csv" };
  }
  return { text: await file.text(), fileName: file.name };
}

export function ImportForm({
  history,
}: {
  history: Array<{
    id: string;
    fileName: string | null;
    importType?: string | null;
    status: string;
    contactsCreated: number | null;
    contactsUpdated: number | null;
    duplicatesFound: number | null;
    createdAt: Date;
  }>;
}) {
  const [tab, setTab] = useState<Tab>("connections");
  const [pending, start] = useTransition();

  const [csvText, setCsvText] = useState("");
  const [fileName, setFileName] = useState("linkedin.csv");
  const [connectionsPreview, setConnectionsPreview] =
    useState<ConnectionsPreview | null>(null);

  const [messagesText, setMessagesText] = useState("");
  const [messagesFileName, setMessagesFileName] = useState("messages.csv");
  const [messagesPreview, setMessagesPreview] =
    useState<MessagesPreview | null>(null);

  const [calendarText, setCalendarText] = useState("");
  const [calendarKind, setCalendarKind] = useState<"ics" | "csv">("ics");
  const [calendarFileName, setCalendarFileName] = useState("calendar.ics");
  const [calendarPreview, setCalendarPreview] =
    useState<CalendarPreview | null>(null);
  const [createFollowUps, setCreateFollowUps] = useState(true);

  const tabs: { id: Tab; label: string }[] = [
    { id: "connections", label: "Connections" },
    { id: "messages", label: "Messages" },
    { id: "calendar", label: "Calendar" },
  ];

  return (
    <div className="space-y-8">
      <div className="flex gap-1 rounded-xl border border-border/60 bg-muted/40 p-1">
        {tabs.map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => setTab(t.id)}
            className={cn(
              "flex-1 rounded-lg px-3 py-2 text-sm font-medium transition-colors",
              tab === t.id
                ? "bg-white text-[#0f3d3e] shadow-sm"
                : "text-muted-foreground hover:text-foreground"
            )}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === "connections" && (
        <div className="space-y-4 rounded-2xl border border-border/70 bg-white p-6">
          <div>
            <p className="text-sm font-medium">Upload LinkedIn connections CSV</p>
            <p className="mt-1 text-sm text-muted-foreground">
              LinkedIn → Settings → Data privacy → Get a copy of your data →
              Connections.
            </p>
          </div>
          <input
            type="file"
            accept=".csv,text/csv"
            onChange={async (e) => {
              const file = e.target.files?.[0];
              if (!file) return;
              setFileName(file.name);
              setCsvText(await file.text());
              setConnectionsPreview(null);
            }}
          />
          <div className="flex gap-2">
            <Button
              disabled={!csvText || pending}
              variant="outline"
              onClick={() =>
                start(async () => {
                  try {
                    const res = await previewLinkedInCsv(csvText);
                    setConnectionsPreview(res);
                    toast.success(`Previewing ${res.totalRows} rows`);
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
              disabled={!csvText || pending}
              className="bg-[#0f3d3e] hover:bg-[#0c3233]"
              onClick={() =>
                start(async () => {
                  try {
                    const res = await confirmLinkedInImport(csvText, fileName);
                    toast.success(
                      `Imported: ${res.contactsCreated} created, ${res.contactsUpdated} updated`
                    );
                    setConnectionsPreview(null);
                    setCsvText("");
                  } catch (err) {
                    toast.error(
                      err instanceof Error ? err.message : "Import failed"
                    );
                  }
                })
              }
            >
              {pending ? "Importing…" : "Confirm import"}
            </Button>
          </div>

          {connectionsPreview && (
            <div className="space-y-3">
              <p className="text-sm text-muted-foreground">
                {connectionsPreview.totalRows} rows ·{" "}
                {connectionsPreview.duplicateCount} likely duplicates in preview
              </p>
              <div className="max-h-80 overflow-auto rounded-xl border border-border/60">
                <table className="w-full text-left text-sm">
                  <thead className="bg-muted/50 text-xs">
                    <tr>
                      <th className="px-3 py-2">Name</th>
                      <th className="px-3 py-2">Company</th>
                      <th className="px-3 py-2">Title</th>
                      <th className="px-3 py-2">Duplicate</th>
                    </tr>
                  </thead>
                  <tbody>
                    {connectionsPreview.preview.map((row, i) => (
                      <tr key={i} className="border-t border-border/50">
                        <td className="px-3 py-2">{row.fullName}</td>
                        <td className="px-3 py-2">{row.company}</td>
                        <td className="px-3 py-2">{row.position}</td>
                        <td className="px-3 py-2">
                          {row.duplicate ? (
                            <Badge variant="secondary">
                              {row.duplicate.reason}
                            </Badge>
                          ) : (
                            "—"
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      )}

      {tab === "messages" && (
        <div className="space-y-4 rounded-2xl border border-border/70 bg-white p-6">
          <div>
            <p className="text-sm font-medium">
              Upload LinkedIn messages CSV or ZIP
            </p>
            <p className="mt-1 text-sm text-muted-foreground">
              LinkedIn → Settings → Data privacy → Get a copy of your data →
              Messages. Upload <code className="text-xs">messages.csv</code> or
              the archive ZIP.
            </p>
          </div>
          <input
            type="file"
            accept=".csv,.zip,text/csv,application/zip"
            onChange={async (e) => {
              const file = e.target.files?.[0];
              if (!file) return;
              try {
                const { text, fileName: name } = await readCsvOrZipMessages(file);
                setMessagesFileName(name);
                setMessagesText(text);
                setMessagesPreview(null);
              } catch (err) {
                toast.error(
                  err instanceof Error ? err.message : "Could not read file"
                );
              }
            }}
          />
          <div className="flex gap-2">
            <Button
              disabled={!messagesText || pending}
              variant="outline"
              onClick={() =>
                start(async () => {
                  try {
                    const res = await previewLinkedInMessagesCsv(messagesText);
                    setMessagesPreview(res);
                    toast.success(
                      `${res.totalConversations} conversations · ${res.matchedCount} matched`
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
              disabled={!messagesText || pending}
              className="bg-[#0f3d3e] hover:bg-[#0c3233]"
              onClick={() =>
                start(async () => {
                  try {
                    const res = await confirmLinkedInMessagesImport(
                      messagesText,
                      messagesFileName
                    );
                    toast.success(
                      `Imported ${res.messagesImported} messages · ${res.contactsCreated} contacts created`
                    );
                    if (res.enrichment) {
                      toast.message(
                        `Enriched ${res.enrichment.contactsEnriched} contacts for chat & follow-ups`
                      );
                    }
                    setMessagesPreview(null);
                    setMessagesText("");
                  } catch (err) {
                    toast.error(
                      err instanceof Error ? err.message : "Import failed"
                    );
                  }
                })
              }
            >
              {pending ? "Importing…" : "Confirm import"}
            </Button>
          </div>

          {messagesPreview && (
            <div className="space-y-3">
              <p className="text-sm text-muted-foreground">
                {messagesPreview.totalMessages} messages ·{" "}
                {messagesPreview.totalConversations} conversations ·{" "}
                {messagesPreview.matchedCount} matched ·{" "}
                {messagesPreview.unmatchedCount} new
              </p>
              <div className="max-h-80 overflow-auto rounded-xl border border-border/60">
                <table className="w-full text-left text-sm">
                  <thead className="bg-muted/50 text-xs">
                    <tr>
                      <th className="px-3 py-2">Conversation</th>
                      <th className="px-3 py-2">Msgs</th>
                      <th className="px-3 py-2">Match</th>
                      <th className="px-3 py-2">Sample</th>
                    </tr>
                  </thead>
                  <tbody>
                    {messagesPreview.preview.map((row) => (
                      <tr
                        key={row.conversationId}
                        className="border-t border-border/50"
                      >
                        <td className="px-3 py-2">{row.title}</td>
                        <td className="px-3 py-2">{row.messageCount}</td>
                        <td className="px-3 py-2">
                          {row.match ? (
                            <Badge variant="secondary">{row.match.reason}</Badge>
                          ) : row.willCreate ? (
                            <Badge variant="outline">Create contact</Badge>
                          ) : (
                            "—"
                          )}
                        </td>
                        <td className="max-w-[220px] truncate px-3 py-2 text-muted-foreground">
                          {row.sampleContent || "—"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      )}

      {tab === "calendar" && (
        <div className="space-y-4 rounded-2xl border border-border/70 bg-white p-6">
          <div>
            <p className="text-sm font-medium">Upload calendar ICS or CSV</p>
            <p className="mt-1 text-sm text-muted-foreground">
              Export from Google Calendar / Apple Calendar / Outlook. Orbit
              matches attendees to existing contacts and logs meetings.
            </p>
          </div>
          <input
            type="file"
            accept=".ics,.csv,text/calendar,text/csv"
            onChange={async (e) => {
              const file = e.target.files?.[0];
              if (!file) return;
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
            />
            Create follow-up reminders for recent past meetings
          </label>
          <div className="flex gap-2">
            <Button
              disabled={!calendarText || pending}
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
              disabled={!calendarText || pending}
              className="bg-[#0f3d3e] hover:bg-[#0c3233]"
              onClick={() =>
                start(async () => {
                  try {
                    const res = await confirmCalendarImport({
                      kind: calendarKind,
                      text: calendarText,
                      fileName: calendarFileName,
                      createFollowUps,
                    });
                    toast.success(
                      `Logged ${res.meetingsLogged} meetings across ${res.contactsMatched} contacts`
                    );
                    setCalendarPreview(null);
                    setCalendarText("");
                  } catch (err) {
                    toast.error(
                      err instanceof Error ? err.message : "Import failed"
                    );
                  }
                })
              }
            >
              {pending ? "Importing…" : "Confirm import"}
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
        </div>
      )}

      <div>
        <h2 className="mb-3 text-lg font-medium">Import history</h2>
        {history.length === 0 ? (
          <p className="text-sm text-muted-foreground">No imports yet.</p>
        ) : (
          <ul className="space-y-2">
            {history.map((h) => (
              <li
                key={h.id}
                className="flex items-center justify-between rounded-xl border border-border/60 bg-white px-4 py-3 text-sm"
              >
                <div>
                  <p className="font-medium">{h.fileName || "Import"}</p>
                  <p className="text-xs text-muted-foreground">
                    {h.importType ? `${h.importType} · ` : ""}
                    {h.contactsCreated ?? 0} created · {h.contactsUpdated ?? 0}{" "}
                    updated · {h.duplicatesFound ?? 0} skipped/dupes
                  </p>
                </div>
                <Badge variant="outline">{h.status}</Badge>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
