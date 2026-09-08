"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { Camera, Images, Smartphone, Upload } from "lucide-react";
import dynamic from "next/dynamic";
import { ScanCameraLazy } from "@/components/imports/scan-camera-lazy";
import { ScanQrHandoff } from "@/components/imports/scan-qr-handoff";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { ingestCaptureMedia } from "@/actions/capture";
import { finishBackgroundJob, startBackgroundJob } from "@/lib/background-jobs";
import { CAPTURE_MAX_UPLOAD_BYTES, formatUploadSize } from "@/lib/capture-limits";
import { DUR, EASE_HOUSE } from "@/lib/motion";
import { toast } from "@/lib/toast";
import { MAX_SCAN_PAGES, ScanError, classifyScanFile } from "@/lib/scan-image";
import { releaseScanPage, type ScanPage } from "@/lib/scan-capture";
import { usePrefersReducedMotion } from "@/lib/use-prefers-reduced-motion";
import { cn } from "@/lib/utils";

/**
 * The review carousel is only reachable once a transcript exists, and it is a large
 * component. Scan is the default tab on /imports, so loading it eagerly would put it in
 * front of everyone who came here for a LinkedIn CSV.
 */
const BulkNotesPanel = dynamic(
  () =>
    import("@/components/chat/bulk-notes-panel").then((m) => ({
      default: m.BulkNotesPanel,
    })),
  {
    loading: () => (
      <div className="space-y-3">
        <Skeleton className="h-24 w-full rounded-xl" />
        <Skeleton className="h-9 w-32" />
      </div>
    ),
  }
);

type Mode = "idle" | "camera" | "qr";

/** Images and PDFs only. Notes as text go to Capture, which is a different job. */
const SCAN_FILE_ACCEPT = "image/*,application/pdf,.pdf,.heic,.heif";

/**
 * Which doors to offer, chosen in CSS rather than JavaScript.
 *
 * A `useIsMobile` hook would server-render as desktop and correct itself after hydration,
 * which on a phone means painting a webcam button and visibly swapping it — and gating on
 * a "have we mounted yet" flag instead renders nothing at all until hydration. Both are
 * the mistake `use-is-lg` warns about in its own doc comment: gate client-only BEHAVIOUR
 * on a media query, never layout. `md` is the mobile line everywhere else in the app
 * (`app-shell.tsx`, `mobile-nav.tsx`), so both sets render and CSS picks one.
 */
const MOBILE_AFFORDANCES = [
  { id: "take", label: "Take a photo", hint: "Use your camera", icon: Camera },
  { id: "roll", label: "Camera roll", hint: "Photo or PDF", icon: Images },
] as const;

const DESKTOP_AFFORDANCES = [
  { id: "upload", label: "Upload", hint: "Image or PDF", icon: Upload },
  { id: "camera", label: "Webcam", hint: "Hold it up", icon: Camera },
  { id: "qr", label: "Use your phone", hint: "Scan a QR code", icon: Smartphone },
] as const;

/**
 * Scan notes: a photo of handwriting, a whiteboard, or a stack of business cards.
 *
 * The extraction engine underneath is exactly the one Capture uses — one pipeline, so
 * contacts, reminders, mentions, dedupe and undo all behave identically no matter which
 * door the notes came in through. What is new here is the doors: a camera, a PDF, and a
 * QR code that turns the phone in your pocket into the scanner.
 */
export function ScanNotesPanel({ hasApiKey }: { hasApiKey?: boolean }) {
  const [mode, setMode] = useState<Mode>("idle");
  const [busy, setBusy] = useState(false);
  const [transcript, setTranscript] = useState<string | null>(null);
  const [sources, setSources] = useState<string[]>([]);
  const [dragging, setDragging] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const nativeCameraRef = useRef<HTMLInputElement>(null);

  const reduced = usePrefersReducedMotion();

  /** Send already-normalized pages for transcription. */
  const readPages = useCallback(async (pages: ScanPage[]) => {
    if (!pages.length) return;

    const totalBytes = pages.reduce((sum, p) => sum + p.bytes, 0);
    if (totalBytes > CAPTURE_MAX_UPLOAD_BYTES) {
      toast.error(
        `Those pages come to ${formatUploadSize(totalBytes)} — the limit is ${formatUploadSize(
          CAPTURE_MAX_UPLOAD_BYTES
        )}. Try fewer at a time.`
      );
      return;
    }

    const jobId = `scan-${Date.now()}`;
    setBusy(true);
    // Indeterminate (both zero), because it would be a lie to draw a bar. Transcription is
    // one server action that fans out to a call per page on the far side, so the browser
    // learns nothing until every page is back — a progress bar here could only be animated
    // rather than measured. The page count goes in the label instead, which is the part we
    // genuinely know.
    startBackgroundJob({
      id: jobId,
      kind: "scan-notes",
      label: pages.length === 1 ? "Reading your page" : `Reading ${pages.length} pages`,
      startedAt: Date.now(),
      done: 0,
      total: 0,
    });

    try {
      const res = await ingestCaptureMedia({
        files: pages.map((p) => ({
          filename: p.filename,
          mimeType: p.mimeType,
          base64: p.base64,
        })),
      });

      if (!res.ok) {
        finishBackgroundJob(jobId, { status: "failed", error: res.error });
        toast.error(res.error);
        return;
      }

      finishBackgroundJob(jobId, {
        status: "completed",
        resultMessage:
          pages.length === 1 ? "Read 1 page" : `Read ${pages.length} pages`,
      });
      setTranscript(res.text);
      setSources(res.sources ?? []);
      setMode("idle");
    } catch (err) {
      const message = err instanceof Error ? err.message : "Could not read those pages.";
      finishBackgroundJob(jobId, { status: "failed", error: message });
      toast.error(message);
    } finally {
      // The blobs only ever backed thumbnails; the base64 has already been sent.
      for (const page of pages) releaseScanPage(page);
      setBusy(false);
    }
  }, []);

  /** Turn picked files (images and/or PDFs) into pages, then read them. */
  const acceptFiles = useCallback(
    async (files: File[]) => {
      if (!files.length) return;
      setBusy(true);
      try {
        // Imported here, not at module scope, so pdfjs and the canvas encoder are fetched
        // only once someone actually picks something.
        const { normalizeImageFile, rasterizePdf } = await import("@/lib/scan-capture");

        const pages: ScanPage[] = [];
        let droppedPages = 0;
        let skipped = 0;

        for (const file of files) {
          if (pages.length >= MAX_SCAN_PAGES) {
            droppedPages += 1;
            continue;
          }
          const kind = classifyScanFile(file.name, file.type);
          try {
            if (kind === "pdf") {
              const out = await rasterizePdf(file);
              pages.push(...out.pages.slice(0, MAX_SCAN_PAGES - pages.length));
              droppedPages += out.dropped;
            } else if (kind === "image") {
              pages.push(await normalizeImageFile(file));
            } else {
              skipped += 1;
            }
          } catch (err) {
            if (err instanceof ScanError && err.reason === "heic-undecodable") {
              // Only Safari decodes HEIC. Naming the fix matters because the person has a
              // button for it right here.
              toast.error(
                `${file.name} is an iPhone HEIC, which this browser can't open. Use "Use your phone" below, or export it as JPEG.`
              );
            } else {
              toast.error(`Could not read ${file.name}.`);
            }
          }
        }

        if (skipped > 0) {
          toast.error(
            skipped === 1
              ? "Skipped a file that wasn't a photo or PDF."
              : `Skipped ${skipped} files that weren't photos or PDFs.`
          );
        }
        if (droppedPages > 0) {
          toast.error(
            `Only the first ${MAX_SCAN_PAGES} pages were kept — send the rest in a second scan.`
          );
        }
        if (!pages.length) return;
        await readPages(pages);
      } finally {
        setBusy(false);
      }
    },
    [readPages]
  );

  // Paste a screenshot straight in. A screenshot of a conference badge or a LinkedIn
  // profile is one of the likeliest inputs, and there was no way to do it before.
  useEffect(() => {
    function onPaste(e: ClipboardEvent) {
      if (busy || transcript) return;
      const files = Array.from(e.clipboardData?.files ?? []);
      const usable = files.filter(
        (f) => classifyScanFile(f.name, f.type) !== "unsupported"
      );
      if (!usable.length) return;
      e.preventDefault();
      void acceptFiles(usable);
    }
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  }, [acceptFiles, busy, transcript]);

  function onPick(e: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? []);
    e.target.value = "";
    void acceptFiles(files);
  }

  if (transcript) {
    return (
      <div className="space-y-3">
        <BulkNotesPanel
          entryPoint="capture"
          hasApiKey={hasApiKey}
          initialText={transcript}
          initialSources={sources}
          autoParse
          onSaved={() => {
            setTranscript(null);
            setSources([]);
          }}
        />
        <Button
          size="sm"
          variant="ghost"
          onClick={() => {
            setTranscript(null);
            setSources([]);
          }}
        >
          Scan something else
        </Button>
      </div>
    );
  }

  function activate(id: string) {
    if (id === "upload" || id === "roll") fileRef.current?.click();
    else if (id === "take") nativeCameraRef.current?.click();
    else if (id === "camera") setMode("camera");
    else if (id === "qr") setMode("qr");
  }

  return (
    <div
      onDragOver={(e) => {
        e.preventDefault();
        if (!dragging) setDragging(true);
      }}
      onDragLeave={(e) => {
        // Only when the pointer leaves the card itself, not on every child boundary.
        if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
        setDragging(false);
      }}
      onDrop={(e) => {
        e.preventDefault();
        setDragging(false);
        void acceptFiles(Array.from(e.dataTransfer.files ?? []));
      }}
      className={cn(
        "space-y-4 rounded-xl border p-4 transition-colors",
        dragging
          ? "border-dashed border-import-scan bg-import-scan/5"
          : "border-border/60"
      )}
    >
      <div className="space-y-1">
        <h2 className="font-heading text-base font-medium text-ink">Scan notes</h2>
        <p className="text-sm text-muted-foreground">
          A photo of your handwriting, a whiteboard, or a stack of business cards. Orbit
          reads it and pulls out the people.
        </p>
      </div>

      <input
        ref={fileRef}
        type="file"
        multiple
        accept={SCAN_FILE_ACCEPT}
        className="sr-only"
        onChange={onPick}
      />
      {/*
        `capture="environment"` is what makes a phone open the camera directly instead of a
        file browser — the single most valuable attribute in this component, and it appears
        nowhere else in the app.
      */}
      <input
        ref={nativeCameraRef}
        type="file"
        accept="image/*"
        capture="environment"
        className="sr-only"
        onChange={onPick}
      />

      <AnimatePresence mode="wait" initial={false}>
        {mode === "camera" ? (
          <motion.div
            key="camera"
            initial={reduced ? false : { opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={reduced ? undefined : { opacity: 0, y: 4 }}
            transition={{ duration: DUR.base, ease: EASE_HOUSE }}
          >
            <ScanCameraLazy
              onDone={(pages) => void readPages(pages)}
              onCancel={() => setMode("idle")}
            />
          </motion.div>
        ) : mode === "qr" ? (
          <motion.div
            key="qr"
            initial={reduced ? false : { opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={reduced ? undefined : { opacity: 0, y: 4 }}
            transition={{ duration: DUR.base, ease: EASE_HOUSE }}
          >
            <ScanQrHandoff
              onTranscript={({ transcript: text, sources: srcs }) => {
                setTranscript(text);
                setSources(srcs);
                setMode("idle");
              }}
              onCancel={() => setMode("idle")}
            />
          </motion.div>
        ) : (
          <motion.div
            key="idle"
            initial={reduced ? false : { opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={reduced ? undefined : { opacity: 0, y: 4 }}
            transition={{ duration: DUR.base, ease: EASE_HOUSE }}
            className="space-y-3"
          >
            {[
              { items: MOBILE_AFFORDANCES, cls: "grid-cols-2 md:hidden" },
              { items: DESKTOP_AFFORDANCES, cls: "hidden md:grid md:grid-cols-3" },
            ].map((set) => (
              <div key={set.cls} className={cn("grid gap-2", set.cls)}>
                {set.items.map((a) => (
                  <button
                    key={a.id}
                    type="button"
                    disabled={busy}
                    onClick={() => activate(a.id)}
                    className={cn(
                      "flex flex-col items-center gap-1.5 rounded-xl border border-border/60 px-3 py-4",
                      "text-center transition-colors hover:border-import-scan/60 hover:bg-import-scan/5",
                      "disabled:opacity-50"
                    )}
                  >
                    <a.icon className="size-5 text-import-scan" />
                    <span className="text-sm font-medium text-ink">{a.label}</span>
                    <span className="text-xs text-muted-foreground">{a.hint}</span>
                  </button>
                ))}
              </div>
            ))}

            <p className="hidden text-xs text-muted-foreground md:block">
              Drop a file anywhere on this card, or paste a screenshot with ⌘V.
            </p>
            {busy && (
              <p className="text-xs text-muted-foreground" aria-live="polite">
                Reading…
              </p>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
