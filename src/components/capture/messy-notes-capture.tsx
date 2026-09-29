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
 *
 * Two or more files at once open the notes sorter first, as the Notes Library tab does, and
 * whatever it confirms — one note or twelve — is read as background jobs that join the
 * upload's queue. Only a SINGLE file lands in the box. The sorter used to send a one-note
 * sort to the box too, but that path fired one upload per file kind ("merge" for text,
 * "replace" for pages) without awaiting either, so which one won the box was a race.
 *
 * A single file is checked against what was already captured (by content hash) before it
 * is read, and Reading… carries a Stop.
 */
import { useEffect, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import { findCapturedFiles } from "@/actions/capture-jobs";
import { hashFilesSequentially } from "@/lib/capture/file-hash";
import { toast } from "@/lib/toast";
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
import { extractLinkedInProfileRefs, isLinkedInOnlyPaste } from "@/lib/linkedin-paste";
import type { CaptureIngest } from "@/lib/capture/use-capture-ingest";
import { isIgnorableFile } from "@/lib/capture/file-drop";
import { useCaptureFanout } from "@/lib/capture/use-capture-fanout";
import type { PlannedUpload } from "@/lib/capture/bins";
import { NotesSorterDialog } from "@/components/capture/notes-sorter-dialog";
import { NotesFanoutList } from "@/components/capture/notes-library-upload";
import { DriveCaptureButton, type DriveCaptureConfig } from "@/components/capture/drive-capture-button";
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
  onQueued,
  drive = null,
  canUseSync = false,
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
  /** The jobs a multi-note sort created, once every note has settled. */
  onQueued?: (jobIds: string[]) => void;
  /** Google Picker config; the Drive button hides itself when this is incomplete. */
  drive?: DriveCaptureConfig | null;
  canUseSync?: boolean;
}) {
  const fanout = useCaptureFanout({ onSettled: onQueued });
  const [incoming, setIncoming] = useState<{ file: File; path: string }[]>([]);
  /** Hashing, checking and decoding a single file before its upload starts. */
  const [preparing, setPreparing] = useState(false);
  const busy = ingest.busy || extracting || fanout.running || preparing;
  const { notes, setNotes, mentionPicks, setMentionPicks } = ingest;
  // A paste of nothing but profile URLs is looked up directly, with no model pass — so it
  // has to stay available when there is no AI key, which is exactly when it matters most.
  const pastedProfiles = extractLinkedInProfileRefs(notes);
  const linkedInOnly = pastedProfiles.length > 0 && isLinkedInOnlyPaste(notes);
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
    const flush = () => writeCaptureDraft(window.localStorage, draftKey, draft);
    // Emptying the box removes the draft on the spot. Debouncing that write let a quick
    // navigation cancel it (`pagehide` does not fire on an in-app route change), so the text
    // the person had just deleted came back on the next visit.
    if (!notes.trim()) {
      flush();
      return;
    }
    const timer = window.setTimeout(flush, DRAFT_SAVE_DELAY_MS);
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
    if (files.length > 1) return openSorter(files);
    await ingestIntoBox(files);
  }

  /**
   * The single-file path: whatever the file says lands in the box, ready to extract.
   *
   * Hashed and checked first. A file this person already captured is not read again
   * unless they say so — the toast's action re-enters here with `force` — because reading
   * it would bill the same pages twice and, once extracted, file the same meeting on the
   * same timeline twice. A failed check is not a refusal: the file is read as it always was.
   */
  async function ingestIntoBox(files: File[], opts: { force?: boolean } = {}) {
    if (!files.length) return;
    setPreparing(true);
    try {
      const fileHashes = (await hashFilesSequentially(files)).filter(Boolean);
      if (!opts.force && fileHashes.length) {
        const res = await findCapturedFiles(fileHashes).catch(() => null);
        const match = res?.ok ? res.matches[0] : null;
        if (match) {
          const when = new Date(match.capturedAt).toLocaleDateString(undefined, { month: "short", day: "numeric" });
          toast.message(
            files.length === 1 ? `You already captured ${files[0]!.name} on ${when}` : `You already captured these on ${when}`,
            {
              description: "Nothing new was read",
              action: { label: "Read it again", onClick: () => void ingestIntoBox(files, { force: true }) },
            }
          );
          return;
        }
      }
      const { pages, raw } = await sortAndNormalizeScanFiles(files);
      // One file makes one of these, never both, so the two uploads cannot race for the box.
      if (raw.length) ingest.handleFilesSelected(raw, { fileHashes });
      if (pages.length) ingest.ingestScanPages(pages, { fileHashes });
    } finally {
      setPreparing(false);
    }
  }

  function openSorter(files: File[]) {
    const kept = files.filter((f) => !isIgnorableFile(f.name));
    if (kept.length === 1) return void ingestIntoBox(kept);
    if (kept.length) setIncoming(kept.map((file) => ({ file, path: "" })));
  }

  /** Every note the sorter confirms is its own job — even when there is only one. */
  function onSorted(plans: PlannedUpload[], resolve: (fileId: string) => File | undefined) {
    setIncoming([]);
    fanout.start(plans, resolve);
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
      {!ingest.hasApiKey && (
        <>
          <MissingKeyNotice reason={ingest.aiReason} />
          <p className="-mt-2 text-xs text-muted-foreground">
            Pasting a LinkedIn profile URL on its own still works without a key.
          </p>
        </>
      )}
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
            placeholder={`AWS Summit afterparty — talked with a few people over drinks about AI tooling.\n\nMet Sarah Chen — she leads Codex partnerships at OpenAI...\n\nAlso caught up with Marcus Lee (Stripe, recruiting). He offered an intro to their AI infra team...\n\nOr paste nothing but a profile URL:\nhttps://www.linkedin.com/in/sarah-chen`}
            textareaClassName={cn("min-h-[220px]", FIELD_BARE)}
            disabled={extracting}
          />
        </div>
        <p className="mt-1.5 text-xs text-muted-foreground">
          Type <span className="font-medium text-foreground">@</span> to name someone already in
          your orbit, or a LinkedIn profile URL on its own is enough to log someone.
        </p>
      </div>

      <div className="space-y-2">
        <ScanControls
          accept={CAPTURE_FILE_ACCEPT}
          disabled={busy}
          onRawFiles={ingest.handleFilesSelected}
          onPages={ingest.ingestScanPages}
          onFiles={(files) => void acceptDropped(files)}
          onTranscript={(text, sources, jobId) => ingest.onPhoneTranscript(text, sources, jobId ?? null)}
        />
        <div className="flex flex-wrap items-center gap-2">
          {/* Each picked doc becomes its own job in this upload's queue, never box text —
              the same rule as a multi-file drop. */}
          <DriveCaptureButton
            drive={drive}
            canUseSync={canUseSync}
            disabled={busy || !ingest.hasApiKey}
            onQueued={(ids) => onQueued?.(ids)}
          />
          {(ingest.busy || preparing) && (
            <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
              <Loader2 className="size-3.5 animate-spin" /> Reading…
              {ingest.busy && <StopReadingButton onStop={ingest.cancel} />}
            </span>
          )}
          <IngestMeta fileName={ingest.fileName} sources={ingest.sources} />
        </div>
        <p className="hidden text-xs text-muted-foreground md:block">Drop a file anywhere on this card, or paste a screenshot.</p>
      </div>

      <Button
        disabled={busy || !ingest.notes.trim() || (!ingest.hasApiKey && !linkedInOnly)}
        className="w-full bg-primary text-primary-foreground hover:bg-primary/90 sm:w-auto"
        onClick={onExtract}
      >
        {linkedInOnly
          ? extracting
            ? "Looking up…"
            : pastedProfiles.length === 1
              ? "Look up profile"
              : `Look up ${pastedProfiles.length} profiles`
          : extracting
            ? "Reading…"
            : "Extract people"}
      </Button>

      {/* Mounted only while open: closing unmounts it, which is what revokes its previews. */}
      {incoming.length > 0 && (
        <NotesSorterDialog incoming={incoming} onCancel={() => setIncoming([])} onConfirm={onSorted} />
      )}
      <NotesFanoutList fanout={fanout} />
    </div>
  );
}

/** Capture's "AI can't run" notice — the shared one, worded for the gate's `reason`. */
export function MissingKeyNotice({ reason }: { reason?: AiAccessDenial | null }) {
  return <AiKeyNotice feature="capture" reason={reason} />;
}

/**
 * Stop, beside a "Reading…" / "Transcribing…" indicator. Shared with the voice tab. Small and
 * quiet on purpose: it sits in a status line, and a loud button there would read as the
 * thing to press next.
 */
export function StopReadingButton({ onStop }: { onStop: () => void }) {
  return (
    <button
      type="button"
      onClick={onStop}
      className="ml-1 rounded font-medium text-foreground underline-offset-2 hover:underline focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none"
    >
      Stop
    </button>
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
