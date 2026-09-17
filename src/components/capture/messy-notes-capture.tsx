"use client";

/**
 * The Messy Notes tab: a box for the notes, and under it the three other ways they can
 * arrive — a file, the webcam, or your phone. Whatever comes in lands in the box; Extract
 * is the one button.
 *
 * The box is a `MentionComposer`, so `@` names somebody already in the orbit. That earns its
 * place here and not only in chat: extraction otherwise works out who a note is about from
 * the prose, and a guess is exactly what you do not want for the person whose name you were
 * about to type anyway. A pick skips the guessing — see `resolveMentionsWithPicks`.
 */
import { useEffect, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import { AiKeyNotice } from "@/components/ai-key-notice";
import { clearCaptureDraft, readCaptureDraft, writeCaptureDraft } from "@/lib/capture-draft";
import { CAPTURE_HANDOFF_EVENT, appendHandoff, takeCaptureHandoff } from "@/lib/capture-handoff";
import { ScanControls, useScanDropZone, sortAndNormalizeScanFiles } from "@/components/scan/scan-controls";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  FIELD_BARE,
  FIELD_SHELL,
  MentionComposer,
} from "@/components/composer/mention-composer";
import { CAPTURE_FILE_ACCEPT } from "@/lib/capture/ingest-client";
import type { CaptureIngest } from "@/lib/capture/use-capture-ingest";
import { cn } from "@/lib/utils";
import type { AiAccessDenial } from "@/lib/managed-ai-policy";

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
  const { notes, setNotes, mentionPicks, setMentionPicks } = ingest;
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
      // Picks come back only alongside the draft's own text. Restored over something the
      // user has already typed they would claim tokens that are not in the box — inert
      // while that is true, and wrong the moment one of those names gets typed.
      if (draft?.notes && !current.trim()) {
        setMentionPicks(draft.mentionPicks);
        setRestored(true);
      }
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
    const draft = { notes, sources: ingest.sources, photoIds: [] as string[], mentionPicks };
    const timer = window.setTimeout(() => writeCaptureDraft(window.localStorage, draftKey, draft), DRAFT_SAVE_DELAY_MS);
    const flush = () => writeCaptureDraft(window.localStorage, draftKey, draft);
    window.addEventListener("pagehide", flush);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener("pagehide", flush);
    };
  }, [draftKey, notes, ingest.sources, mentionPicks]);

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
      {!ingest.hasApiKey && <MissingKeyNotice reason={ingest.aiReason} />}
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
                setMentionPicks([]);
                setRestored(false);
                if (draftKey) clearCaptureDraft(window.localStorage, draftKey);
              }}
            >
              Restored from your last visit · clear
            </button>
          )}
        </div>
        {/* `relative` so the `@` menu — which `MentionComposer` renders as a sibling of the
            field box — anchors to the notes box rather than to the whole card. Below it
            rather than above: this box is most of a screen tall and you type at the bottom
            of it, so a menu above the box would open a long way from the caret. */}
        <div className="relative mt-2">
          <MentionComposer
            className={FIELD_SHELL}
            textareaRef={notesRef}
            value={ingest.notes}
            onValueChange={ingest.setNotes}
            picks={ingest.mentionPicks}
            onPicksChange={ingest.setMentionPicks}
            menuPlacement="below"
            // People only — `events` stays off. An event row splices a sentence about a past
            // conversation, which is something you do when asking a question, not when
            // writing one up.
            menuEnabled={!extracting}
            id="capture-notes"
            placeholder={`AWS Summit afterparty — talked with a few people over drinks about AI tooling.\n\nMet Sarah Chen — she leads Codex partnerships at OpenAI...\n\nAlso caught up with Marcus Lee (Stripe, recruiting). He offered an intro to their AI infra team...`}
            textareaClassName={cn("min-h-[220px]", FIELD_BARE)}
            disabled={extracting}
          />
        </div>
        <p className="mt-1.5 text-xs text-muted-foreground">
          Type <span className="font-medium text-foreground">@</span> to name someone already
          in your orbit — the note links to them instead of the name being guessed at.
        </p>
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

/** Capture's "AI can't run" notice — the shared one, worded for the gate's `reason`. */
export function MissingKeyNotice({ reason }: { reason?: AiAccessDenial | null }) {
  return <AiKeyNotice feature="capture" reason={reason} />;
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
