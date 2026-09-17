"use client";

/**
 * Drop a folder of meeting notes; each file becomes its own capture.
 *
 * The difference from Messy Notes is the whole point: that tab merges everything you give it
 * into ONE corpus with one date, one summary and one timeline entry — right for a single
 * meeting, wrong for a year of standups. Here each file is its own job, its own date and its
 * own row on the right person's timeline.
 *
 * The date beside each file is editable before the run starts, because all three ways of
 * guessing it (content, filename, mtime) are wrong sometimes, and a wrong anchor silently
 * shifts every relative reminder in that note.
 */
import { useRef } from "react";
import { CalendarClock, FileText, Loader2, Upload, X } from "lucide-react";
import { CAPTURE_FILE_ACCEPT } from "@/lib/capture/ingest-client";
import { useCaptureFanout } from "@/lib/capture/use-capture-fanout";
import { useScanDropZone } from "@/components/scan/scan-controls";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
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
  /** The jobs this drop created, once every file has settled. */
  onQueued: (jobIds: string[]) => void;
}) {
  const pickerRef = useRef<HTMLInputElement>(null);
  const fanout = useCaptureFanout({ onSettled: onQueued });
  const { dragging, dropProps } = useScanDropZone({
    onFiles: fanout.add,
    disabled: fanout.running || !hasApiKey,
  });

  const { entries, summary, running } = fanout;
  const canStart = entries.some((e) => e.status === "pending") && hasApiKey && !running;

  return (
    <div role="tabpanel" id={panelId} aria-labelledby={tabId} className="space-y-4">
      <div
        {...dropProps}
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
          Each file becomes its own meeting — its own date, its own people, its own entry on
          their timeline. Text, Markdown, PDFs, photos, calendar invites and emails.
        </p>
        <input
          ref={pickerRef}
          type="file"
          multiple
          accept={CAPTURE_FILE_ACCEPT}
          className="sr-only"
          onChange={(e) => {
            fanout.add(Array.from(e.target.files ?? []));
            // Cleared so re-picking the same file fires `change` again.
            e.target.value = "";
          }}
        />
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="mt-3"
          disabled={running || !hasApiKey}
          onClick={() => pickerRef.current?.click()}
        >
          <Upload className="size-4" />
          Choose files
        </Button>
        {!hasApiKey && (
          <p className="mt-2 text-xs text-muted-foreground">
            Add an AI key in Settings to read notes.
          </p>
        )}
      </div>

      {fanout.rejected && (
        <p className="text-sm text-destructive">{fanout.rejected}</p>
      )}

      {entries.length > 0 && (
        <div className="space-y-3 rounded-2xl border border-border/70 p-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-sm font-medium text-foreground">
              {entries.length} {entries.length === 1 ? "file" : "files"}
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
              <Button type="button" size="sm" disabled={!canStart} onClick={fanout.start}>
                {running ? (
                  <>
                    <Loader2 className="size-4 animate-spin" />
                    Reading…
                  </>
                ) : (
                  `Read ${entries.filter((e) => e.status === "pending").length} notes`
                )}
              </Button>
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
                    {sizeLabel(e.bytes)} · {STATUS_COPY[e.status]}
                    {e.error ? ` — ${e.error}` : ""}
                  </span>
                </span>

                <span className="flex items-center gap-1.5">
                  <CalendarClock className="size-3.5 text-muted-foreground" />
                  <Input
                    type="date"
                    aria-label={`Date for ${e.label}`}
                    className="h-8 w-[9.5rem]"
                    value={e.anchorIso ?? ""}
                    disabled={e.status !== "pending"}
                    onChange={(ev) => fanout.setAnchor(e.id, ev.target.value || null)}
                  />
                </span>

                {e.status === "pending" && (
                  <Button
                    type="button"
                    size="icon"
                    variant="ghost"
                    aria-label={`Remove ${e.label}`}
                    onClick={() => fanout.remove(e.id)}
                  >
                    <X className="size-4" />
                  </Button>
                )}
                {e.status === "uploading" && <Loader2 className="size-4 animate-spin text-muted-foreground" />}
              </li>
            ))}
          </ul>

          <p className="text-xs text-muted-foreground">
            {/* Saying where the date came from matters: a filename date is evidence, a
                modified-time is a guess, and nothing at all means today. */}
            Dates come from the filename where Orbit can read one — anything in the notes
            themselves still wins. Edit any of them before you start.
          </p>
        </div>
      )}

      {running && entries.length === 0 && <Skeleton className="h-24 w-full rounded-2xl" />}
    </div>
  );
}

export function NotesLibraryUploadFallback() {
  return <Skeleton className="h-48 w-full rounded-2xl" />;
}

export type { FanoutEntry };
