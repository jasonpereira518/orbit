"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "@/lib/toast";
import {
  previewLinkedInMessagesCsv,
  confirmLinkedInMessagesImport,
} from "@/actions/imports";
import { Button } from "@/components/ui/button";
import { ImportPeopleReview } from "@/components/imports/import-people-review";
import { LinkedInExportGuide } from "@/components/imports/linkedin-export-guide";
import {
  BusyHint,
  ImportProgress,
  readCsvOrZipMessages,
  useBatchedImport,
} from "@/components/imports/import-utils";

type MessagesPreview = Awaited<ReturnType<typeof previewLinkedInMessagesCsv>>;
type MessagePerson = MessagesPreview["people"][number];

export function LinkedInMessagesImport() {
  const router = useRouter();
  const [pending, start] = useTransition();
  const { importProgress, runBatchedImport } = useBatchedImport();

  const [messagesText, setMessagesText] = useState("");
  const [fileName, setFileName] = useState("messages.csv");
  const [people, setPeople] = useState<MessagePerson[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [meta, setMeta] = useState<{ totalMessages: number } | null>(null);

  const busy = pending || importProgress !== null;

  function applyPreview(res: MessagesPreview) {
    setPeople(res.people);
    setSelected(new Set(res.people.map((p) => p.id)));
    setMeta({ totalMessages: res.totalMessages });
  }

  return (
    <section className="space-y-4 rounded-2xl border border-border/70 bg-card p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-medium text-primary">
            LinkedIn messages
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Upload a Messages CSV or ZIP, review conversation partners, then
            import message history.
          </p>
        </div>
        <LinkedInExportGuide variant="messages" />
      </div>

      <input
        type="file"
        accept=".csv,.zip,text/csv,application/zip"
        disabled={busy}
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (!file) return;
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

      {pending && !importProgress ? (
        <BusyHint>Reading messages…</BusyHint>
      ) : null}
      {importProgress ? <ImportProgress {...importProgress} /> : null}

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
          onClick={async () => {
            if (busy) return;
            try {
              const ids = [...selected];
              let messagesImported = 0;
              let enrichmentTotal = 0;
              const res = await runBatchedImport(
                ids,
                ids.length === 1 ? "person" : "people",
                async (chunk, opts) => {
                  const chunkRes = await confirmLinkedInMessagesImport(
                    messagesText,
                    fileName,
                    chunk,
                    opts
                  );
                  messagesImported += chunkRes.chunkMessagesImported;
                  enrichmentTotal +=
                    chunkRes.enrichment?.contactsEnriched ?? 0;
                  return chunkRes;
                }
              );
              toast.success(
                `Imported ${messagesImported} messages · ${res.contactsCreated} contacts created`
              );
              if (enrichmentTotal > 0) {
                toast.message(
                  `Enriched ${enrichmentTotal} contacts for chat & follow-ups`
                );
              }
              setPeople([]);
              setSelected(new Set());
              setMeta(null);
              setMessagesText("");
              router.refresh();
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
