"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Camera, ScanLine, Smartphone, Upload } from "lucide-react";
import { ScanCameraLazy } from "@/components/scan/scan-camera-lazy";
import { ScanQrHandoff } from "@/components/scan/scan-qr-handoff";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { toast } from "@/lib/toast";
import { MAX_SCAN_PAGES, ScanError, classifyScanFile } from "@/lib/scan-image";
import type { ScanPage } from "@/lib/scan-capture";
import { cn } from "@/lib/utils";

type Mode = "idle" | "camera" | "qr";

/**
 * The ways a photograph gets into Orbit: a file, a webcam, or the phone in your pocket.
 *
 * Owns only the *acquisition* of pages — picking, framing, normalizing — and hands them
 * up. Transcription, the notes textarea and the review carousel all belong to
 * `BulkNotesPanel`, which is where the extraction pipeline already lived; this exists so
 * that scanning is one more way to fill that textarea rather than a second pipeline
 * beside it.
 *
 * It owns the file input rather than the host, because a picked file has to be SORTED
 * before it can be used: images and PDFs need decoding and re-encoding first, while a
 * .txt, .ics or voice memo goes to the server untouched. Only this component knows how to
 * tell those apart.
 */
export type SortedScanFiles = {
  /** Images and PDF pages, downscaled and re-encoded to JPEG. */
  pages: ScanPage[];
  /** Text, calendar, email and audio — passed through untouched. */
  raw: File[];
};

/**
 * Sort picked or dropped files, and decode the visual ones.
 *
 * Exported so a host's drop zone runs the identical path as the file picker — one place
 * that knows a PDF must be rasterized before anything can read it, and one place that
 * knows what to say about a HEIC this browser cannot open.
 *
 * `pdfjs` and the canvas encoder are imported inside so they are fetched only once
 * somebody actually picks something.
 */
export async function sortAndNormalizeScanFiles(
  files: File[]
): Promise<SortedScanFiles> {
  const raw: File[] = [];
  const visual: File[] = [];
  for (const file of files) {
    if (classifyScanFile(file.name, file.type) === "unsupported") raw.push(file);
    else visual.push(file);
  }
  if (!visual.length) return { pages: [], raw };

  const { normalizeImageFile, rasterizePdf } = await import("@/lib/scan-capture");
  const pages: ScanPage[] = [];
  let droppedPages = 0;

  for (const file of visual) {
    if (pages.length >= MAX_SCAN_PAGES) {
      droppedPages += 1;
      continue;
    }
    try {
      if (classifyScanFile(file.name, file.type) === "pdf") {
        const out = await rasterizePdf(file);
        pages.push(...out.pages.slice(0, MAX_SCAN_PAGES - pages.length));
        droppedPages += out.dropped;
      } else {
        pages.push(await normalizeImageFile(file));
      }
    } catch (err) {
      if (err instanceof ScanError && err.reason === "heic-undecodable") {
        // Only Safari decodes HEIC. Naming the fix matters, because the person has a
        // button for it a few pixels away.
        toast.error(
          `${file.name} is an iPhone photo this browser can’t open — send it with "Use your phone", or export it as JPEG`
        );
      } else {
        toast.error(`Couldn’t read ${file.name} — try a different one?`);
      }
    }
  }

  if (droppedPages > 0) {
    toast.error(
      `Only the first ${MAX_SCAN_PAGES} pages were kept — send the rest in a second scan`
    );
  }
  return { pages, raw };
}

export function ScanControls({
  accept,
  disabled = false,
  onRawFiles,
  onPages,
  onTranscript,
}: {
  /** The host's accept string, for the general picker. */
  accept: string;
  disabled?: boolean;
  /** Text, calendar, email and audio files — passed through untouched. */
  onRawFiles: (files: File[]) => void;
  /** Images and PDF pages, already downscaled and re-encoded to JPEG. */
  onPages: (pages: ScanPage[]) => void;
  /** The phone handoff returns text the server already transcribed, and the job it sits on. */
  onTranscript: (text: string, sources: string[], captureJobId?: string) => void;
}) {
  const [mode, setMode] = useState<Mode>("idle");
  const [normalizing, setNormalizing] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const nativeCameraRef = useRef<HTMLInputElement>(null);

  const acceptFiles = useCallback(
    async (files: File[]) => {
      if (!files.length) return;
      setNormalizing(true);
      try {
        const { pages, raw } = await sortAndNormalizeScanFiles(files);
        // Notes, calendar invites and voice memos never needed decoding.
        if (raw.length) onRawFiles(raw);
        if (pages.length) onPages(pages);
      } finally {
        setNormalizing(false);
      }
    },
    [onPages, onRawFiles]
  );

  // Paste a screenshot straight in. A screenshot of a conference badge or a LinkedIn
  // profile is one of the likeliest inputs, and there was no way to do it before.
  useEffect(() => {
    function onPaste(e: ClipboardEvent) {
      if (disabled || normalizing) return;
      const files = Array.from(e.clipboardData?.files ?? []).filter(
        (f) => classifyScanFile(f.name, f.type) !== "unsupported"
      );
      if (!files.length) return;
      e.preventDefault();
      void acceptFiles(files);
    }
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  }, [acceptFiles, disabled, normalizing]);

  function onPick(e: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? []);
    e.target.value = "";
    void acceptFiles(files);
  }

  const busy = disabled || normalizing;

  return (
    <div className="space-y-3">
      <input
        ref={fileRef}
        type="file"
        multiple
        accept={accept}
        className="hidden"
        onChange={onPick}
      />
      {/*
        `capture="environment"` is what makes a phone open the camera directly instead of a
        file browser. It is the whole reason the mobile layout differs from the desktop one.
      */}
      <input
        ref={nativeCameraRef}
        type="file"
        accept="image/*"
        capture="environment"
        className="hidden"
        onChange={onPick}
      />

      {/*
        Both sets render and CSS picks one — never a `useIsMobile` hook, which would
        server-render the desktop set and visibly swap it on a phone. `use-is-lg` warns
        about exactly this in its own doc comment. `md` is the mobile line everywhere else
        in the app (`app-shell.tsx`, `mobile-nav.tsx`).

        Below md the affordances are tap tiles, because a thumb needs a bigger target than
        a pointer does. Webcam and the phone handoff are desktop-only: a phone already has
        its camera in the tile beside them, and QR-ing a link to yourself is pointless.
      */}
      <div className="grid grid-cols-2 gap-2 md:hidden">
        <ScanTile icon={Upload} label="Upload" hint="Notes, photo or PDF" disabled={busy}
          onClick={() => fileRef.current?.click()} />
        <ScanTile icon={Camera} label="Take a photo" hint="Use your camera" disabled={busy}
          onClick={() => nativeCameraRef.current?.click()} />
      </div>

      <div className="hidden flex-wrap items-center gap-2 md:flex">
        <Button type="button" variant="outline" disabled={busy}
          onClick={() => fileRef.current?.click()}>
          <Upload className="size-4" />
          Upload notes / media
        </Button>
        <Button type="button" variant="outline" disabled={busy}
          onClick={() => setMode("camera")}>
          <Camera className="size-4" />
          Webcam
        </Button>
        <Button type="button" variant="outline" disabled={busy}
          onClick={() => setMode("qr")}>
          <Smartphone className="size-4" />
          Use your phone
        </Button>
      </div>

      {/*
        Popups, not inline panels. Expanding in place pushed "Extract people" and the rest
        of the card down the page by a viewfinder's height; a dialog keeps the notes card
        exactly where it was, and puts the camera where the person is already looking.

        Base UI unmounts a closed popup's content (`keepMounted` defaults to false), which
        is what turns the camera off: `ScanCamera`'s cleanup stops every track on unmount,
        and `ScanQrHandoff`'s cancels a grant nobody redeemed. Escape and the backdrop both
        close, and closing means cancelling — neither dialog has a state worth keeping.
      */}
      <Dialog
        open={mode === "camera"}
        onOpenChange={(open) => {
          if (!open) setMode("idle");
        }}
      >
        {/* Narrower than the default: the viewfinder is an upright page, so width past it is empty. */}
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Scan with your webcam</DialogTitle>
            <DialogDescription>
              Hold each page upright inside the outline and take a photo. Add as many
              pages as you need, then read them.
            </DialogDescription>
          </DialogHeader>
          <ScanCameraLazy
            // Stops the camera on the click that closes the dialog, not on the unmount
            // after its exit animation — see `active` in scan-camera.tsx.
            active={mode === "camera"}
            onDone={(pages) => {
              setMode("idle");
              onPages(pages);
            }}
            onCancel={() => setMode("idle")}
          />
        </DialogContent>
      </Dialog>

      <Dialog
        open={mode === "qr"}
        onOpenChange={(open) => {
          if (!open) setMode("idle");
        }}
      >
        <DialogContent>
          {/* Centered to sit over the centered code, rather than left-aligned above it. */}
          <DialogHeader className="items-center text-center">
            <DialogTitle>Use your phone</DialogTitle>
            <DialogDescription>
              Scan this code with your phone&apos;s camera. It opens a page that sends your
              photos straight here — no sign-in.
            </DialogDescription>
          </DialogHeader>
          <ScanQrHandoff
            // Cancels the code on the click that closes the dialog, not on the unmount.
            active={mode === "qr"}
            onTranscript={({ transcript, sources, captureJobId }) => {
              setMode("idle");
              onTranscript(transcript, sources, captureJobId);
            }}
            onCancel={() => setMode("idle")}
          />
        </DialogContent>
      </Dialog>
    </div>
  );
}

function ScanTile({
  icon: Icon,
  label,
  hint,
  disabled,
  onClick,
}: {
  icon: typeof Camera;
  label: string;
  hint: string;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "flex flex-col items-center gap-1.5 rounded-xl border border-border/60 px-3 py-4 text-center",
        "transition-colors hover:border-import-scan/60 hover:bg-import-scan/5",
        "disabled:opacity-50"
      )}
    >
      <Icon className="size-5 text-import-scan" />
      <span className="text-sm font-medium text-ink">{label}</span>
      <span className="text-xs text-muted-foreground">{hint}</span>
    </button>
  );
}

/** The chip that marks a scan-related header, matching the import panels' icon chips. */
export function ScanChip() {
  return (
    <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-import-scan/10 text-import-scan">
      <ScanLine className="h-4 w-4" />
    </span>
  );
}

/**
 * Drag-and-drop for the whole host card, rather than just the button row.
 *
 * A hook rather than a wrapper element so the host decides what the drop target is — in
 * Capture that is the entire notes card, textarea included, which is where someone
 * dragging a photo will aim.
 */
export function useScanDropZone({
  onFiles,
  disabled = false,
}: {
  onFiles: (files: File[]) => void;
  disabled?: boolean;
}) {
  const [dragging, setDragging] = useState(false);

  const dropProps = {
    onDragOver: (e: React.DragEvent) => {
      if (disabled) return;
      e.preventDefault();
      if (!dragging) setDragging(true);
    },
    onDragLeave: (e: React.DragEvent) => {
      // Only when the pointer leaves the card itself, not on every child boundary.
      if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
      setDragging(false);
    },
    onDrop: (e: React.DragEvent) => {
      if (disabled) return;
      e.preventDefault();
      setDragging(false);
      onFiles(Array.from(e.dataTransfer.files ?? []));
    },
  };

  return { dragging, dropProps };
}
