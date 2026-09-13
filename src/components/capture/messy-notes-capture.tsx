"use client";

/**
 * The Messy Notes tab: a box for the notes, and under it the three other ways they can
 * arrive — a file, the webcam, or your phone. Whatever comes in lands in the box; Extract
 * is the one button.
 */
import Link from "next/link";
import { Loader2 } from "lucide-react";
import { ScanControls, useScanDropZone, sortAndNormalizeScanFiles } from "@/components/scan/scan-controls";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { CAPTURE_FILE_ACCEPT } from "@/lib/capture/ingest-client";
import type { CaptureIngest } from "@/lib/capture/use-capture-ingest";
import { cn } from "@/lib/utils";

export function MessyNotesCapture({
  ingest,
  onExtract,
  extracting,
  preferredContactName,
  panelId,
  tabId,
}: {
  ingest: CaptureIngest;
  onExtract: () => void;
  extracting: boolean;
  preferredContactName?: string | null;
  panelId: string;
  tabId: string;
}) {
  const busy = ingest.busy || extracting;
  const { dragging, dropProps } = useScanDropZone({
    onFiles: (files) => void acceptDropped(files),
    disabled: busy,
  });

  async function acceptDropped(files: File[]) {
    if (!files.length) return;
    const { pages, raw } = await sortAndNormalizeScanFiles(files);
    if (raw.length) ingest.handleFilesSelected(raw);
    if (pages.length) ingest.ingestScanPages(pages);
  }

  return (
    <div
      id={panelId}
      role="tabpanel"
      aria-labelledby={tabId}
      {...dropProps}
      className={cn(
        "space-y-4 rounded-2xl border border-border/70 bg-card p-5 transition-colors sm:p-6",
        dragging && "border-dashed border-import-scan bg-import-scan/5"
      )}
    >
      {!ingest.hasApiKey && <MissingKeyNotice />}
      {preferredContactName && (
        <p className="rounded-xl bg-muted/50 px-3 py-2 text-sm text-muted-foreground">
          Logging with <span className="font-medium text-foreground">{preferredContactName}</span> preferred for merge when they appear in the notes.
        </p>
      )}
      <div>
        <Label htmlFor="capture-notes">Your notes</Label>
        <Textarea
          id="capture-notes"
          className="mt-2 min-h-[220px]"
          placeholder={`AWS Summit afterparty — talked with a few people over drinks about AI tooling.\n\nMet Sarah Chen — she leads Codex partnerships at OpenAI...\n\nAlso caught up with Marcus Lee (Stripe, recruiting). He offered an intro to their AI infra team...`}
          value={ingest.notes}
          onChange={(e) => ingest.setNotes(e.target.value)}
          disabled={extracting}
        />
      </div>

      <div className="space-y-2">
        <ScanControls
          accept={CAPTURE_FILE_ACCEPT}
          disabled={busy}
          onRawFiles={ingest.handleFilesSelected}
          onPages={ingest.ingestScanPages}
          onTranscript={(text, sources, jobId) => ingest.onPhoneTranscript(text, sources, jobId ?? null)}
        />
        <div className="flex flex-wrap items-center gap-2">
          {ingest.busy && (
            <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
              <Loader2 className="size-3.5 animate-spin" /> Reading…
            </span>
          )}
          <IngestMeta fileName={ingest.fileName} sources={ingest.sources} />
        </div>
        <p className="hidden text-xs text-muted-foreground md:block">Drop a file anywhere on this card, or paste a screenshot.</p>
      </div>

      <Button
        disabled={busy || !ingest.notes.trim() || !ingest.hasApiKey}
        className="w-full bg-primary text-primary-foreground hover:bg-primary/90 sm:w-auto"
        onClick={onExtract}
      >
        {extracting ? "Reading…" : "Extract people"}
      </Button>
    </div>
  );
}

export function MissingKeyNotice() {
  return (
    <div className="rounded-xl border border-amber-200/80 bg-amber-50/70 px-3 py-3 text-sm dark:border-amber-900/50 dark:bg-amber-950/30">
      <p className="font-medium text-foreground">Add an AI API key to extract people from notes</p>
      <p className="mt-1 text-muted-foreground">
        Orbit needs your Gemini, OpenAI, or Anthropic key — add one in{" "}
        <Link href="/settings" className="font-medium text-primary underline-offset-2 hover:underline">
          Settings
        </Link>
        , then come back here.
      </p>
    </div>
  );
}

/** Filename and provenance for whatever was last ingested — "note.jpg · via photos:2". */
export function IngestMeta({ fileName, sources }: { fileName: string | null; sources: string[] }) {
  if (!fileName && !sources.length) return null;
  return (
    <span className="truncate text-xs text-muted-foreground">
      {fileName}
      {fileName && sources.length ? " · " : ""}
      {sources.length ? `via ${sources.join(", ")}` : ""}
    </span>
  );
}
