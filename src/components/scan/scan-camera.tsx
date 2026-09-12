"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { Camera, RotateCcw, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { toast } from "@/lib/toast";
import { DUR, EASE_HOUSE, SPRING_PILL, SPRING_TAP } from "@/lib/motion";
import { usePrefersReducedMotion } from "@/lib/use-prefers-reduced-motion";
import {
  capturePageFromVideo,
  openCameraStream,
  releaseScanPage,
  stopCameraStream,
  type ScanPage,
} from "@/lib/scan-capture";
import { MAX_SCAN_PAGES, ScanError } from "@/lib/scan-image";
import { cn } from "@/lib/utils";
import { VIEWFINDER_STYLE } from "@/components/scan/viewfinder";

/**
 * The live camera, on a laptop's webcam or a phone's rear camera.
 *
 * Lazily loaded (see `scan-camera-lazy.tsx`): `getUserMedia` and the canvas encoder should
 * not be in the bundle of someone who never scans anything. The permission prompt is only
 * ever triggered by a click, never on mount.
 */
export function ScanCamera({
  active = true,
  onDone,
  onCancel,
}: {
  /**
   * Whether the camera should be running. Goes false the instant the host starts closing.
   *
   * Unmounting is not soon enough on its own. This renders inside a dialog, and a dialog
   * unmounts its content only after its exit animation finishes — which, in a tab the
   * person has just switched away from, may not be for a very long time, because a hidden
   * tab does not advance animations. The camera indicator would stay lit the whole while,
   * which people reasonably read as the app still watching them. Keying the stream on
   * this flag turns the camera off on the click, not on the unmount.
   */
  active?: boolean;
  /** Called with the captured pages. The caller owns releasing their object URLs. */
  onDone: (pages: ScanPage[]) => void;
  onCancel: () => void;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const [ready, setReady] = useState(false);
  const [denied, setDenied] = useState<string | null>(null);
  const [pages, setPages] = useState<ScanPage[]>([]);
  const [flash, setFlash] = useState(false);
  const [busy, setBusy] = useState(false);
  const reduced = usePrefersReducedMotion();

  useEffect(() => {
    // Closed or closing: open nothing. The previous run's cleanup has already stopped the
    // stream — that is the whole point of depending on `active`.
    if (!active) return;
    let cancelled = false;
    (async () => {
      try {
        const stream = await openCameraStream();
        if (cancelled) {
          stopCameraStream(stream);
          return;
        }
        streamRef.current = stream;
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          await videoRef.current.play().catch(() => {});
        }
        setReady(true);
      } catch (err) {
        const reason = err instanceof ScanError ? err.reason : "unknown";
        setDenied(
          reason === "camera-denied"
            ? "Orbit needs camera access. Allow it in your browser's site settings, then try again — or send the photo from your phone instead."
            : reason === "insecure-context"
              ? "Browsers only allow the camera over HTTPS. Use the phone handoff instead."
              : "No camera found on this device."
        );
      }
    })();
    return () => {
      // Runs when `active` goes false AND on unmount — every exit path. `cancelled` also
      // catches a permission prompt still pending when the dialog closed: its stream is
      // stopped the moment it resolves instead of being attached to a closing viewfinder.
      cancelled = true;
      stopCameraStream(streamRef.current);
      streamRef.current = null;
    };
  }, [active]);

  /**
   * Pages the person shot and then cancelled out of would otherwise leak their blobs.
   * Done through a functional update so it always sees the current list without mirroring
   * state into a ref during render.
   */
  const releaseAll = useCallback(() => {
    setPages((prev) => {
      for (const page of prev) releaseScanPage(page);
      return [];
    });
  }, []);

  const shoot = useCallback(async () => {
    if (!videoRef.current || busy) return;
    if (pages.length >= MAX_SCAN_PAGES) {
      toast.error(`That’s the ${MAX_SCAN_PAGES}-page limit for one scan`);
      return;
    }
    setBusy(true);
    try {
      const page = await capturePageFromVideo(videoRef.current);
      setPages((prev) => [...prev, page]);
      if (!reduced) {
        setFlash(true);
        window.setTimeout(() => setFlash(false), 90);
      }
    } catch {
      toast.error("That shot didn’t come out — try again");
    } finally {
      setBusy(false);
    }
  }, [busy, pages.length, reduced]);

  function discard(id: string) {
    setPages((prev) => {
      const page = prev.find((p) => p.id === id);
      if (page) releaseScanPage(page);
      return prev.filter((p) => p.id !== id);
    });
  }

  if (denied) {
    return (
      <div className="space-y-3">
        <p className="text-sm text-muted-foreground">{denied}</p>
        <Button size="sm" variant="outline" onClick={onCancel}>
          Close
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {/*
        An upright page, not the webcam's own landscape frame. `object-cover` shows the
        middle of the feed, and `capturePageFromVideo` crops the photo to exactly that
        middle, so what is inside this box is what gets read.
      */}
      <div
        className="relative mx-auto overflow-hidden rounded-2xl bg-black"
        style={VIEWFINDER_STYLE}
      >
        <video
          ref={videoRef}
          muted
          playsInline
          className="absolute inset-0 size-full object-cover"
        />

        {/*
          The page outline, inset by the same fraction on every axis so it keeps the page's
          shape. The margin outside it is dimmed but still captured: the outline says where
          the page goes, and a corner that strays over it is not cut off. Purely decorative.
        */}
        <div
          aria-hidden
          className="pointer-events-none absolute inset-[6%] rounded-lg border border-white/35 shadow-[0_0_0_100vmax_rgb(0_0_0/0.35)]"
        >
          {[
            "-left-px -top-px border-l-2 border-t-2 rounded-tl-lg",
            "-right-px -top-px border-r-2 border-t-2 rounded-tr-lg",
            "-left-px -bottom-px border-l-2 border-b-2 rounded-bl-lg",
            "-right-px -bottom-px border-r-2 border-b-2 rounded-br-lg",
          ].map((corner) => (
            <span
              key={corner}
              className={cn("absolute size-7 border-white/90", corner)}
            />
          ))}
        </div>

        <AnimatePresence>
          {flash && (
            <motion.div
              aria-hidden
              className="absolute inset-0 bg-white"
              initial={{ opacity: 0.85 }}
              animate={{ opacity: 0 }}
              exit={{ opacity: 0 }}
              transition={{ duration: DUR.base, ease: EASE_HOUSE }}
            />
          )}
        </AnimatePresence>

        <div className="absolute inset-x-0 bottom-0 flex items-center justify-center gap-4 p-4">
          <motion.button
            type="button"
            onClick={shoot}
            disabled={!ready || busy}
            whileTap={reduced ? undefined : { scale: 0.9 }}
            transition={SPRING_TAP}
            aria-label="Take photo"
            // A dark fill, not a light one: this sits on the page, and a well-framed page is
            // white right where the shutter is. A white-on-white button disappears.
            className="grid size-16 place-items-center rounded-full border-4 border-white bg-black/45 shadow-lg shadow-black/30 backdrop-blur disabled:opacity-40"
          >
            <Camera className="size-6 text-white" />
          </motion.button>
        </div>
      </div>

      {pages.length > 0 && (
        <ul className="flex flex-wrap gap-2" aria-label="Captured pages">
          <AnimatePresence initial={false}>
            {pages.map((page, i) => (
              <motion.li
                key={page.id}
                layout={!reduced}
                initial={reduced ? false : { opacity: 0, scale: 0.9 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={reduced ? undefined : { opacity: 0, scale: 0.9 }}
                transition={SPRING_PILL}
                className="relative"
              >
                {/* eslint-disable-next-line @next/next/no-img-element -- a blob: object URL from the camera, not a remote asset */}
                <img
                  src={page.previewUrl}
                  alt={`Page ${i + 1}`}
                  className="h-16 rounded-md border border-border/60 object-cover"
                  style={{ aspectRatio: VIEWFINDER_STYLE.aspectRatio }}
                />
                <span className="absolute bottom-0 left-0 rounded-br-lg rounded-tl-lg bg-black/60 px-1 text-[10px] text-white">
                  {i + 1}
                </span>
                <button
                  type="button"
                  onClick={() => discard(page.id)}
                  aria-label={`Discard page ${i + 1}`}
                  className="absolute -right-1.5 -top-1.5 grid size-5 place-items-center rounded-full border border-border bg-card text-muted-foreground hover:text-ink"
                >
                  <X className="size-3" />
                </button>
              </motion.li>
            ))}
          </AnimatePresence>
        </ul>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          disabled={!pages.length}
          className="bg-primary text-primary-foreground hover:bg-primary/90"
          onClick={() => onDone(pages)}
        >
          {/* The count in the label, so the action is concrete rather than a bare verb. */}
          {pages.length <= 1
            ? "Read this page"
            : `Read ${pages.length} pages`}
        </Button>
        {pages.length > 0 && (
          <Button
            size="sm"
            variant="ghost"
            onClick={releaseAll}
          >
            <RotateCcw className="size-3.5" />
            Start over
          </Button>
        )}
        <Button
          size="sm"
          variant="ghost"
          onClick={() => {
            releaseAll();
            onCancel();
          }}
        >
          Cancel
        </Button>
      </div>
    </div>
  );
}
