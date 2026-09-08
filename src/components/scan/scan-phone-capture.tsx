"use client";

import { useCallback, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { Camera, Check, Images, X } from "lucide-react";
import { ScanChip } from "@/components/scan/scan-controls";
import { Button } from "@/components/ui/button";
import { toast } from "@/lib/toast";
import { SPRING_PILL } from "@/lib/motion";
import { usePrefersReducedMotion } from "@/lib/use-prefers-reduced-motion";
import { releaseScanPage, type ScanPage } from "@/lib/scan-capture";
import { MAX_SCAN_PAGES, ScanError, classifyScanFile } from "@/lib/scan-image";

/**
 * The phone half of the handoff: photograph pages, send them to the waiting desktop.
 *
 * Uses the NATIVE camera via `capture="environment"` rather than `getUserMedia`. For
 * photographing a page that is the better tool by some distance — autofocus, tap to focus,
 * HDR and the phone's own shutter processing all apply, and none of them do to a frame
 * grabbed out of a video stream. The in-app camera is for the laptop, where there is no
 * native picker to hand off to.
 *
 * Deliberately importable without a Clerk session: nothing here touches auth, and the page
 * that renders it is public. Authorization is the token in the URL and nothing else.
 */
export function ScanPhoneCapture({ token }: { token: string }) {
  const [pages, setPages] = useState<ScanPage[]>([]);
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const cameraRef = useRef<HTMLInputElement>(null);
  const rollRef = useRef<HTMLInputElement>(null);
  const reduced = usePrefersReducedMotion();

  const addFiles = useCallback(async (files: File[]) => {
    if (!files.length) return;
    setBusy(true);
    try {
      const { normalizeImageFile, rasterizePdf } = await import("@/lib/scan-capture");
      const added: ScanPage[] = [];
      for (const file of files) {
        const kind = classifyScanFile(file.name, file.type);
        try {
          if (kind === "pdf") {
            const out = await rasterizePdf(file);
            added.push(...out.pages);
          } else if (kind === "image") {
            added.push(await normalizeImageFile(file));
          }
        } catch (err) {
          // Safari decodes HEIC natively, so this is rare on the device this page is for.
          toast.error(
            err instanceof ScanError && err.reason === "heic-undecodable"
              ? "That photo is in a format this browser can't open."
              : `Could not read ${file.name}.`
          );
        }
      }
      setPages((prev) => {
        const room = Math.max(0, MAX_SCAN_PAGES - prev.length);
        if (added.length > room) {
          toast.error(`That's the ${MAX_SCAN_PAGES}-page limit for one scan.`);
          for (const extra of added.slice(room)) releaseScanPage(extra);
        }
        return [...prev, ...added.slice(0, room)];
      });
    } finally {
      setBusy(false);
    }
  }, []);

  function onPick(e: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? []);
    e.target.value = "";
    void addFiles(files);
  }

  function discard(id: string) {
    setPages((prev) => {
      const page = prev.find((p) => p.id === id);
      if (page) releaseScanPage(page);
      return prev.filter((p) => p.id !== id);
    });
  }

  async function send() {
    if (!pages.length || busy) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/scan/${encodeURIComponent(token)}/pages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          files: pages.map((p) => ({
            filename: p.filename,
            mimeType: p.mimeType,
            base64: p.base64,
          })),
        }),
      });
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        toast.error(
          body.error ??
            (res.status === 404
              ? "This link has expired. Generate a new QR code on your computer."
              : "Could not send those pages.")
        );
        return;
      }
      for (const page of pages) releaseScanPage(page);
      setPages([]);
      setSent(true);
    } catch {
      toast.error("Could not reach Orbit. Check your connection and try again.");
    } finally {
      setBusy(false);
    }
  }

  if (sent) {
    return (
      <div className="flex flex-col items-center gap-3 text-center">
        <div className="grid size-14 place-items-center rounded-full bg-import-scan/15">
          <Check className="size-7 text-import-scan" />
        </div>
        <h1 className="font-heading text-xl font-medium text-ink">Sent</h1>
        <p className="text-sm text-muted-foreground">
          Finish up on your computer — your notes are already there.
        </p>
        <Button variant="outline" size="sm" onClick={() => setSent(false)}>
          Send more pages
        </Button>
      </div>
    );
  }

  return (
    <div className="flex w-full flex-col gap-5">
      {/*
        The same icon chip the scan controls use in Capture, so the two halves of one
        handoff look like one feature. The display face stays here and only here: this is a
        standalone page with a real page title, not a panel heading inside a card.
      */}
      <div className="flex flex-col items-center gap-2 text-center">
        <ScanChip />
        <h1 className="font-heading text-xl font-medium text-ink">Scan your notes</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Photograph each page. They&apos;ll appear on your computer.
        </p>
      </div>

      <input
        ref={cameraRef}
        type="file"
        accept="image/*"
        capture="environment"
        className="sr-only"
        onChange={onPick}
      />
      <input
        ref={rollRef}
        type="file"
        multiple
        accept="image/*,application/pdf,.pdf"
        className="sr-only"
        onChange={onPick}
      />

      {pages.length > 0 && (
        <ul className="flex flex-wrap justify-center gap-2" aria-label="Pages to send">
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
                {/* eslint-disable-next-line @next/next/no-img-element -- a local blob: URL, not a remote asset */}
                <img
                  src={page.previewUrl}
                  alt={`Page ${i + 1}`}
                  className="size-20 rounded-lg border border-border/60 object-cover"
                />
                <span className="absolute bottom-0 left-0 rounded-br-lg rounded-tl-lg bg-black/60 px-1 text-[10px] text-white">
                  {i + 1}
                </span>
                <button
                  type="button"
                  onClick={() => discard(page.id)}
                  aria-label={`Remove page ${i + 1}`}
                  className="absolute -right-1.5 -top-1.5 grid size-6 place-items-center rounded-full border border-border bg-card text-muted-foreground"
                >
                  <X className="size-3.5" />
                </button>
              </motion.li>
            ))}
          </AnimatePresence>
        </ul>
      )}

      {/* Thumb-reachable, and the primary action is the big one. */}
      <div className="flex flex-col gap-2">
        <Button
          size="lg"
          disabled={busy}
          className="h-14 w-full bg-primary text-base text-primary-foreground hover:bg-primary/90"
          onClick={() => cameraRef.current?.click()}
        >
          <Camera className="size-5" />
          {pages.length ? "Take another photo" : "Take a photo"}
        </Button>
        <Button
          size="lg"
          variant="outline"
          disabled={busy}
          className="h-12 w-full"
          onClick={() => rollRef.current?.click()}
        >
          <Images className="size-4" />
          Choose from camera roll
        </Button>
        {pages.length > 0 && (
          <Button
            size="lg"
            disabled={busy}
            className="h-14 w-full bg-import-scan text-base text-white hover:bg-import-scan/90"
            onClick={() => void send()}
          >
            {busy
              ? "Sending…"
              : pages.length === 1
                ? "Send to computer"
                : `Send ${pages.length} pages`}
          </Button>
        )}
      </div>
    </div>
  );
}
