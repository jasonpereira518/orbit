"use client";

import { useEffect, useState, useTransition } from "react";
import { toast } from "@/lib/toast";
import {
  previewLinkedInMessagesCsv,
} from "@/actions/imports";
import { Button } from "@/components/ui/button";
import { ImportPeopleReview } from "@/components/imports/import-people-review";
import { LinkedInExportGuide } from "@/components/imports/linkedin-export-guide";
import {
  BusyHint,
  ImportFilePicker,
  readCsvOrZipMessages,
} from "@/components/imports/import-utils";
import {
  startImportJob,
  useImportJob,
} from "@/lib/import-job-runner";

type MessagesPreview = Awaited<ReturnType<typeof previewLinkedInMessagesCsv>>;
type MessagePerson = MessagesPreview["people"][number];

export function LinkedInMessagesImport() {
  const job = useImportJob();
  const [pending, start] = useTransition();

  const [messagesText, setMessagesText] = useState("");
  const [fileName, setFileName] = useState<string | null>(null);
  const [people, setPeople] = useState<MessagePerson[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [meta, setMeta] = useState<{ totalMessages: number } | null>(null);

  const messagesJob =
    job?.kind === "messages" && job.status === "running" ? job : null;
  const importProgress = messagesJob?.progress ?? null;
  const busy = pending || job?.status === "running";

  useEffect(() => {
    if (!job || job.kind !== "messages") return;
    if (job.status !== "completed" && job.status !== "failed" && job.status !== "cancelled") return;
    setPeople([]);
    setSelected(new Set());
    setMeta(null);
    setMessagesText("");
    setFileName(null);
  }, [job]);

  function applyPreview(res: MessagesPreview) {
    setPeople(res.people);
    setSelected(
      new Set(res.people.filter((p) => !p.isRepeat).map((p) => p.id))
    );
    setMeta({ totalMessages: res.totalMessages });
  }

  return (
    <section className="space-y-4 rounded-2xl border border-border/70 bg-card p-6">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0 flex-1 pr-2">
          <h2 className="text-lg font-medium text-primary">
            LinkedIn messages
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Upload a Messages CSV or ZIP, review conversation partners, then
            import message history. Imports keep running if you leave this page.
          </p>
        </div>
        <LinkedInExportGuide variant="messages" />
      </div>

      <ImportFilePicker
        accept=".csv,.zip,text/csv,application/zip"
        disabled={busy}
        fileName={fileName}
        onFile={(file) => {
          start(async () => {
            try {
              const { text, fileName: name } = await readCsvOrZipMessages(file);
              setFileName(name);
              setMessagesText(text);
              const res = await previewLinkedInMessagesCsv(text);
              applyPreview(res);
              toast.success(
                `Loaded ${res.totalConversations} people from ${res.totalMessages} messages`
              );
            } catch (err) {
              setPeople([]);
              setSelected(new Set());
              setMeta(null);
              toast.error(
                err instanceof Error ? err.message : "Could not read file"
              );
            }
          });
        }}
      />

      {pending ? <BusyHint>Reading messages…</BusyHint> : null}

      <div className="flex flex-wrap gap-2">
        <Button
          disabled={!messagesText || busy}
          variant="outline"
          onClick={() =>
            start(async () => {
              try {
                const res = await previewLinkedInMessagesCsv(messagesText);
                applyPreview(res);
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
          disabled={!messagesText || busy || selected.size === 0}
          className="bg-primary text-primary-foreground hover:bg-primary/90"
          onClick={() => {
            if (busy) return;
            try {
              const ids = [...selected];
              startImportJob({
                kind: "messages",
                csvText: messagesText,
                fileName: fileName || "messages.csv",
                ids,
              });
              setPeople([]);
              setSelected(new Set());
              setMeta(null);
              setMessagesText("");
              setFileName(null);
            } catch (err) {
              toast.error(
                err instanceof Error ? err.message : "Import failed"
              );
            }
          }}
        >
          {importProgress
            ? `Importing… ${importProgress.done}/${importProgress.total}`
            : `Import ${selected.size || 0} selected`}
        </Button>
      </div>

      {people.length > 0 && (
        <div className="space-y-2">
          {meta ? (
            <p className="text-xs text-muted-foreground">
              From {meta.totalMessages} messages across {people.length}{" "}
              conversations
            </p>
          ) : null}
          <ImportPeopleReview
            people={people.map((p) => ({
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
            selectedIds={selected}
            onSelectedIdsChange={setSelected}
            onRemove={(id) => {
              setPeople((prev) => prev.filter((p) => p.id !== id));
              setSelected((prev) => {
                const next = new Set(prev);
                next.delete(id);
                return next;
              });
            }}
          />
        </div>
      )}
    </section>
  );
}
