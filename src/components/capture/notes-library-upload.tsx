"use client";

/**
 * Drop a folder of meeting notes; sort it into notes; read them.
 *
 * The difference from Messy Notes is the whole point: that tab merges everything you give it
 * into ONE corpus with one date, one summary and one timeline entry — right for a single
 * meeting, wrong for a year of standups. Here you decide the grouping, in
 * `notes-sorter-dialog.tsx`, and each bin becomes its own job, date and timeline row.
 *
 * ## Folders need their own drop handler
 *
 * `useScanDropZone` reads `dataTransfer.files`, which does NOT contain the contents of a
 * dropped directory — a dropped folder arrives as one zero-byte entry that reads as an empty
 * file. That is why this zone walks `webkitGetAsEntry()` itself through
 * `src/lib/capture/file-drop.ts` instead of reusing the shared one.
 */
import { useCallback, useRef, useState } from "react";
import { FileText, FolderOpen, Loader2, Upload } from "lucide-react";
import { CAPTURE_FILE_ACCEPT } from "@/lib/capture/ingest-client";
import { useCaptureFanout } from "@/lib/capture/use-capture-fanout";
import {
  entriesFromDataTransfer,
  isIgnorableFile,
  pathFromRelative,
  readDroppedEntries,
  type DroppedFile,
} from "@/lib/capture/file-drop";
import { NotesSorterDialog } from "@/components/capture/notes-sorter-dialog";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import type { FanoutEntry } from "@/lib/capture/fanout";

function sizeLabel(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

const STATUS_COPY: Record<FanoutEntry["status"], string> = {
  pending: "Waiting to upload",
  uploading: "Reading…",
  waiting: "Rate limited — retrying",
  queued: "Reading in the background",
  failed: "Failed",
  skipped: "Skipped",
};

export function NotesLibraryUpload({
  hasApiKey,
  panelId,
  tabId,
  onQueued,
}: {
  hasApiKey: boolean;
  panelId: string;
  tabId: string;
  /** The jobs this drop created, once every bin has settled. */
  onQueued: (jobIds: string[]) => void;
}) {
  const filePickerRef = useRef<HTMLInputElement>(null);
  const folderPickerRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const [reading, setReading] = useState(false);
  const [incoming, setIncoming] = useState<DroppedFile[]>([]);
  const [sorterOpen, setSorterOpen] = useState(false);

  const fanout = useCaptureFanout({ onSettled: onQueued });
  const { entries, summary, running } = fanout;
  const busy = running || !hasApiKey;

  const stage = useCallback((files: DroppedFile[]) => {
    if (!files.length) return;
    setIncoming(files);
    setSorterOpen(true);
  }, []);

  const onDrop = useCallback(
    async (e: React.DragEvent) => {
      e.preventDefault();
      setDragging(false);
      if (busy) return;
      // Snapshot before awaiting: a `DataTransfer` is emptied once the event handler
      // returns, so reading it after the first `await` finds nothing.
      const entriesFromDt = entriesFromDataTransfer(e.dataTransfer);
      const fallback = Array.from(e.dataTransfer.files ?? []);
      setReading(true);
      try {
        const out = await readDroppedEntries(entriesFromDt, fallback);
        stage(out.files);
      } finally {
        setReading(false);
      }
    },
    [busy, stage]
  );

  function fromPicker(list: FileList | null) {
    const files = Array.from(list ?? [])
      .filter((f) => !isIgnorableFile(f.name))
      .map((file) => ({
        file,
        path: pathFromRelative(
          (file as File & { webkitRelativePath?: string }).webkitRelativePath,
          file.name
        ),
      }));
    stage(files);
  }

  return (
    <div role="tabpanel" id={panelId} aria-labelledby={tabId} className="space-y-4">
      <div
        onDragOver={(e) => {
          if (busy) return;
          e.preventDefault();
          if (!dragging) setDragging(true);
        }}
        onDragLeave={(e) => {
          if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
          setDragging(false);
        }}
        onDrop={(e) => void onDrop(e)}
        className={cn(
          "rounded-2xl border border-dashed p-6 text-center transition-colors",
          dragging ? "border-primary bg-primary/5" : "border-border/70 bg-muted/20"
        )}
      >
        <FileText className="mx-auto size-6 text-muted-foreground" />
        <p className="mt-2 text-sm font-medium text-foreground">
          Drop a folder of meeting notes
        </p>
        <p className="mx-auto mt-1 max-w-md text-xs text-muted-foreground">
          You sort them into notes before anything is read — photos of one whiteboard
          together, everything else on its own. Text, Markdown, PDFs, photos, calendar
          invites and emails.
        </p>

        <input
          ref={filePickerRef}
          type="file"
          multiple
          accept={CAPTURE_FILE_ACCEPT}
          className="sr-only"
          onChange={(e) => {
            fromPicker(e.target.files);
            // Cleared so re-picking the same files fires `change` again.
            e.target.value = "";
          }}
        />
        {/* `webkitdirectory` is not in React's attribute types and is the only way to offer a
            folder picker in any engine that has one. Spread so TypeScript does not reject it. */}
        <input
          ref={folderPickerRef}
          type="file"
          multiple
          className="sr-only"
          {...{ webkitdirectory: "", directory: "" }}
          onChange={(e) => {
            fromPicker(e.target.files);
            e.target.value = "";
          }}
        />

        <div className="mt-3 flex flex-wrap justify-center gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={busy || reading}
            onClick={() => filePickerRef.current?.click()}
          >
            <Upload className="size-4" />
            Choose files
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={busy || reading}
            onClick={() => folderPickerRef.current?.click()}
          >
            <FolderOpen className="size-4" />
            Choose a folder
          </Button>
        </div>

        {reading && (
          <p className="mt-2 inline-flex items-center gap-1.5 text-xs text-muted-foreground">
            <Loader2 className="size-3.5 animate-spin" />
            Reading that folder…
          </p>
        )}
        {!hasApiKey && (
          <p className="mt-2 text-xs text-muted-foreground">
            Add an AI key in Settings to read notes.
          </p>
        )}
      </div>

      {/* Mounted only while open, so closing unmounts it — which is what lets the dialog
          revoke forty object URLs in an unmount cleanup rather than resetting its own state
          from an effect. */}
      {sorterOpen && (
        <NotesSorterDialog
          incoming={incoming}
          onCancel={() => {
            setSorterOpen(false);
            setIncoming([]);
          }}
          onConfirm={(plans, resolve) => {
            fanout.start(plans, resolve);
            setSorterOpen(false);
            setIncoming([]);
          }}
        />
      )}

      {entries.length > 0 && (
        <div className="space-y-3 rounded-2xl border border-border/70 p-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-sm font-medium text-foreground">
              {entries.length} {entries.length === 1 ? "note" : "notes"}
              {running && (
                <span className="ml-2 font-normal text-muted-foreground">
                  {summary.queued} read · {summary.inFlight + summary.waiting} in flight ·{" "}
                  {summary.pending} waiting
                </span>
              )}
            </p>
            <div className="flex gap-2">
              {running ? (
                <Button type="button" variant="ghost" size="sm" onClick={fanout.cancelPending}>
                  Stop
                </Button>
              ) : (
                <Button type="button" variant="ghost" size="sm" onClick={fanout.reset}>
                  Clear
                </Button>
              )}
            </div>
          </div>

          <ul className="space-y-2">
            {entries.map((e) => (
              <li
                key={e.id}
                className="flex flex-wrap items-center gap-2 rounded-xl border border-border/60 bg-card p-2.5"
              >
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm text-foreground">{e.label}</span>
                  <span className="text-xs text-muted-foreground">
                    {e.fileCount} {e.fileCount === 1 ? "file" : "files"} · {sizeLabel(e.bytes)}
                    {e.anchorIso ? ` · ${e.anchorIso}` : ""} · {STATUS_COPY[e.status]}
                    {e.error ? ` — ${e.error}` : ""}
                  </span>
                </span>
                {e.status === "uploading" && (
                  <Loader2 className="size-4 animate-spin text-muted-foreground" />
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

export function NotesLibraryUploadFallback() {
  return <Skeleton className="h-48 w-full rounded-2xl" />;
}

export type { FanoutEntry };
