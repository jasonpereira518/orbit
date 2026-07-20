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
import { CalendarSubscribePanel } from "@/components/imports/calendar-subscribe-panel";
import { ImportPeopleReview } from "@/components/imports/import-people-review";

type Tab = "connections" | "messages" | "calendar";

type ConnectionsPreview = Awaited<ReturnType<typeof previewLinkedInCsv>>;
type MessagesPreview = Awaited<ReturnType<typeof previewLinkedInMessagesCsv>>;
type CalendarPreview = Awaited<ReturnType<typeof previewCalendarImport>>;

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

type ConnectionPerson = ConnectionsPreview["people"][number];
type MessagePerson = MessagesPreview["people"][number];

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
  calendarSubscriptions = [],
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
  calendarSubscriptions?: CalendarSub[];
}) {
  const [tab, setTab] = useState<Tab>("connections");
  const [pending, start] = useTransition();

  const [csvText, setCsvText] = useState("");
  const [fileName, setFileName] = useState("linkedin.csv");
  const [connectionPeople, setConnectionPeople] = useState<ConnectionPerson[]>(
    []
  );
  const [connectionSelected, setConnectionSelected] = useState<Set<string>>(
    new Set()
  );

  const [messagesText, setMessagesText] = useState("");
  const [messagesFileName, setMessagesFileName] = useState("messages.csv");
  const [messagePeople, setMessagePeople] = useState<MessagePerson[]>([]);
  const [messageSelected, setMessageSelected] = useState<Set<string>>(
    new Set()
  );
  const [messagesMeta, setMessagesMeta] = useState<{
    totalMessages: number;
  } | null>(null);

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

  function applyConnectionsPreview(res: ConnectionsPreview) {
    setConnectionPeople(res.people);
    setConnectionSelected(new Set(res.people.map((p) => p.id)));
  }

  function applyMessagesPreview(res: MessagesPreview) {
    setMessagePeople(res.people);
    setMessageSelected(new Set(res.people.map((p) => p.id)));
    setMessagesMeta({ totalMessages: res.totalMessages });
  }

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
              Connections. Review everyone below before importing.
            </p>
          </div>
          <input
            type="file"
            accept=".csv,text/csv"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (!file) return;
              start(async () => {
                try {
                  setFileName(file.name);
                  const text = await file.text();
                  setCsvText(text);
                  const res = await previewLinkedInCsv(text);
                  applyConnectionsPreview(res);
                  toast.success(`Loaded ${res.totalRows} people`);
                } catch (err) {
                  setConnectionPeople([]);
                  setConnectionSelected(new Set());
                  toast.error(
                    err instanceof Error ? err.message : "Preview failed"
                  );
                }
              });
            }}
          />
          <div className="flex flex-wrap gap-2">
            <Button
              disabled={!csvText || pending}
              variant="outline"
              onClick={() =>
                start(async () => {
                  try {
                    const res = await previewLinkedInCsv(csvText);
                    applyConnectionsPreview(res);
                    toast.success(`Loaded ${res.totalRows} people`);
                  } catch (err) {
                    toast.error(
                      err instanceof Error ? err.message : "Preview failed"
                    );
                  }
                })
              }
            >
              Refresh list
            </Button>
            <Button
              disabled={!csvText || pending || connectionSelected.size === 0}
              className="bg-[#0f3d3e] hover:bg-[#0c3233]"
              onClick={() =>
                start(async () => {
                  try {
                    const res = await confirmLinkedInImport(
                      csvText,
                      fileName,
                      [...connectionSelected]
                    );
                    toast.success(
                      `Imported: ${res.contactsCreated} created, ${res.contactsUpdated} updated`
                    );
                    setConnectionPeople([]);
                    setConnectionSelected(new Set());
                    setCsvText("");
                  } catch (err) {
                    toast.error(
                      err instanceof Error ? err.message : "Import failed"
                    );
                  }
                })
              }
            >
              {pending
                ? "Importing…"
                : `Import ${connectionSelected.size || 0} selected`}
            </Button>
          </div>

          {connectionPeople.length > 0 && (
            <ImportPeopleReview
              people={connectionPeople.map((p) => ({
                id: p.id,
                name: p.fullName,
                subtitle: [p.position, p.company].filter(Boolean).join(" · "),
                isRepeat: p.isRepeat,
                repeatReason: p.duplicate?.reason,
              }))}
              selectedIds={connectionSelected}
              onSelectedIdsChange={setConnectionSelected}
              onRemove={(id) => {
                setConnectionPeople((prev) => prev.filter((p) => p.id !== id));
                setConnectionSelected((prev) => {
                  const next = new Set(prev);
                  next.delete(id);
                  return next;
                });
              }}
            />
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
              Messages. Review each conversation partner before importing.
            </p>
          </div>
          <input
            type="file"
            accept=".csv,.zip,text/csv,application/zip"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (!file) return;
              start(async () => {
                try {
                  const { text, fileName: name } =
                    await readCsvOrZipMessages(file);
                  setMessagesFileName(name);
                  setMessagesText(text);
                  const res = await previewLinkedInMessagesCsv(text);
                  applyMessagesPreview(res);
                  toast.success(
                    `Loaded ${res.totalConversations} people from ${res.totalMessages} messages`
                  );
                } catch (err) {
                  setMessagePeople([]);
                  setMessageSelected(new Set());
                  setMessagesMeta(null);
                  toast.error(
                    err instanceof Error ? err.message : "Could not read file"
                  );
                }
              });
            }}
          />
          <div className="flex flex-wrap gap-2">
            <Button
              disabled={!messagesText || pending}
              variant="outline"
              onClick={() =>
                start(async () => {
                  try {
                    const res = await previewLinkedInMessagesCsv(messagesText);
                    applyMessagesPreview(res);
                    toast.success(`Loaded ${res.totalConversations} people`);
                  } catch (err) {
                    toast.error(
                      err instanceof Error ? err.message : "Preview failed"
                    );
                  }
                })
              }
            >
              Refresh list
            </Button>
            <Button
              disabled={!messagesText || pending || messageSelected.size === 0}
              className="bg-[#0f3d3e] hover:bg-[#0c3233]"
              onClick={() =>
                start(async () => {
                  try {
                    const res = await confirmLinkedInMessagesImport(
                      messagesText,
                      messagesFileName,
                      [...messageSelected]
                    );
                    toast.success(
                      `Imported ${res.messagesImported} messages · ${res.contactsCreated} contacts created`
                    );
                    if (res.enrichment) {
                      toast.message(
                        `Enriched ${res.enrichment.contactsEnriched} contacts for chat & follow-ups`
                      );
                    }
                    setMessagePeople([]);
                    setMessageSelected(new Set());
                    setMessagesMeta(null);
                    setMessagesText("");
                  } catch (err) {
                    toast.error(
                      err instanceof Error ? err.message : "Import failed"
                    );
                  }
                })
              }
            >
              {pending
                ? "Importing…"
                : `Import ${messageSelected.size || 0} selected`}
            </Button>
          </div>

          {messagePeople.length > 0 && (
            <div className="space-y-2">
              {messagesMeta ? (
                <p className="text-xs text-muted-foreground">
                  From {messagesMeta.totalMessages} messages across{" "}
                  {messagePeople.length} conversations
                </p>
              ) : null}
              <ImportPeopleReview
                people={messagePeople.map((p) => ({
                  id: p.id,
                  name: p.displayName,
                  subtitle: p.isRepeat
                    ? `Matched: ${p.match?.fullName || p.title}`
                    : p.linkedinUrl
                      ? p.linkedinUrl
                      : p.willCreate
                        ? "Will create new contact"
                        : p.title,
                  meta: `${p.messageCount} message${p.messageCount === 1 ? "" : "s"}${
                    p.sampleContent ? ` · ${p.sampleContent}` : ""
                  }`,
                  isRepeat: p.isRepeat,
                  repeatReason: p.match?.reason || "Already in your network",
                }))}
                selectedIds={messageSelected}
                onSelectedIdsChange={setMessageSelected}
                onRemove={(id) => {
                  setMessagePeople((prev) => prev.filter((p) => p.id !== id));
                  setMessageSelected((prev) => {
                    const next = new Set(prev);
                    next.delete(id);
                    return next;
                  });
                }}
              />
            </div>
          )}
        </div>
      )}

      {tab === "calendar" && (
        <div className="space-y-6">
          <CalendarSubscribePanel
            initialSubscriptions={calendarSubscriptions}
          />

          <div className="space-y-4 rounded-2xl border border-border/70 bg-white p-6">
            <div>
              <p className="text-sm font-medium">One-time upload (ICS or CSV)</p>
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
