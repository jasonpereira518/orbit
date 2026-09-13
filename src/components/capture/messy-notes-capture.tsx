"use client";

/**
 * The Messy Notes tab: a box for the notes, and under it the three other ways they can
 * arrive — a file, the webcam, or your phone. Whatever comes in lands in the box; Extract
 * is the one button.
 */
import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Loader2 } from "lucide-react";
import { clearCaptureDraft, readCaptureDraft, writeCaptureDraft } from "@/lib/capture-draft";
import { CAPTURE_HANDOFF_EVENT, appendHandoff, takeCaptureHandoff } from "@/lib/capture-handoff";
import { ScanControls, useScanDropZone, sortAndNormalizeScanFiles } from "@/components/scan/scan-controls";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { CAPTURE_FILE_ACCEPT } from "@/lib/capture/ingest-client";
import type { CaptureIngest } from "@/lib/capture/use-capture-ingest";
import { cn } from "@/lib/utils";

/** Debounce for the draft autosave: long enough not to write on every keystroke. */
const DRAFT_SAVE_DELAY_MS = 500;

export function MessyNotesCapture({
  ingest,
  onExtract,
  extracting,
  preferredContactName,
  panelId,
  tabId,
  draftKey,
  acceptsHandoff = false,
}: {
  ingest: CaptureIngest;
  onExtract: () => void;
  extracting: boolean;
  preferredContactName?: string | null;
  panelId: string;
  tabId: string;
  /** `captureDraftKey(userId, contactId)` — the notes box autosaves under it (see capture-draft.ts). */
  draftKey?: string | null;
  /** The command palette's "Capture this" text lands here. Off when logging with one person. */
  acceptsHandoff?: boolean;
}) {
  const busy = ingest.busy || extracting;
  const { notes, setNotes } = ingest;
  const [restored, setRestored] = useState(false);
  const notesRef = useRef<HTMLTextAreaElement>(null);
  const loadedKeyRef = useRef<string | null>(null);

  // Restore the draft (and take a waiting handoff) once per key. Deferred a microtask —
  // this reads an external store, not props — and a superseded run must not read at all,
  // because taking the handoff is destructive.
  useEffect(() => {
    if (!draftKey) return;
    let cancelled = false;
    queueMicrotask(() => {
      if (cancelled) return;
      const draft = readCaptureDraft(window.localStorage, draftKey);
      const handed = acceptsHandoff ? takeCaptureHandoff(window.sessionStorage) : null;
      const current = notesRef.current?.value ?? "";
      const base = current.trim() ? current : (draft?.notes ?? "");
      const next = handed ? appendHandoff(base, handed) : base;
      if (next !== current) setNotes(next);
      if (draft?.notes && !current.trim()) setRestored(true);
      loadedKeyRef.current = draftKey;
      if (handed) notesRef.current?.focus();
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draftKey, acceptsHandoff]);

  // "Capture this" while this page is already open: no navigation, so no mount to read it.
  useEffect(() => {
    if (!acceptsHandoff) return;
    function onHandoff() {
      const handed = takeCaptureHandoff(window.sessionStorage);
      if (!handed) return;
      setNotes(appendHandoff(notesRef.current?.value ?? "", handed));
      notesRef.current?.focus();
    }
    window.addEventListener(CAPTURE_HANDOFF_EVENT, onHandoff);
    return () => window.removeEventListener(CAPTURE_HANDOFF_EVENT, onHandoff);
  }, [acceptsHandoff, setNotes]);

  // Autosave while the notes are being written; flushed on pagehide so closing the tab
  // right after typing — the case the draft exists for — loses nothing.
  useEffect(() => {
    if (!draftKey || loadedKeyRef.current !== draftKey) return;
    const draft = { notes, sources: ingest.sources, photoIds: [] as string[] };
    const timer = window.setTimeout(() => writeCaptureDraft(window.localStorage, draftKey, draft), DRAFT_SAVE_DELAY_MS);
    const flush = () => writeCaptureDraft(window.localStorage, draftKey, draft);
    window.addEventListener("pagehide", flush);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener("pagehide", flush);
    };
  }, [draftKey, notes, ingest.sources]);

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
        <div className="flex items-baseline justify-between gap-2">
          <Label htmlFor="capture-notes">Your notes</Label>
          {restored && notes.trim() && (
            <button
              type="button"
              className="text-xs text-muted-foreground underline-offset-2 hover:underline"
              onClick={() => {
                setNotes("");
                setRestored(false);
                if (draftKey) clearCaptureDraft(window.localStorage, draftKey);
              }}
            >
              Restored from your last visit · clear
            </button>
          )}
        </div>
        <Textarea
          ref={notesRef}
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
