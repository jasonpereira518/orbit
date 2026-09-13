"use client";

import { useCallback, useRef, useState } from "react";
import Link from "next/link";
import { AnimatePresence, motion } from "motion/react";
import { Camera, Check, ChevronLeft, ChevronRight, Images, X } from "lucide-react";
import { OrbitLogo } from "@/components/orbit-logo";
import { Button } from "@/components/ui/button";
import { OFFLINE_MESSAGE, friendlyError } from "@/lib/errors";
import { toast } from "@/lib/toast";
import { SPRING_PILL } from "@/lib/motion";
import { usePrefersReducedMotion } from "@/lib/use-prefers-reduced-motion";
import { movePage, releaseScanPage, type ScanPage } from "@/lib/scan-capture";
import { MAX_SCAN_PAGES, ScanError, classifyScanFile } from "@/lib/scan-image";

/**
 * The phone half of the handoff: photograph pages, put them in order, send them to the
 * waiting desktop — and send more, until you say you're done.
 *
 * Uses the NATIVE camera via `capture="environment"` rather than `getUserMedia`. For
 * photographing a page that is the better tool by some distance — autofocus, tap to focus,
 * HDR and the phone's own shutter processing all apply, and none of them do to a frame
 * grabbed out of a video stream. The in-app camera is for the laptop, where there is no
 * native picker to hand off to.
 *
 * Reordering is two buttons per tile, not drag: on a phone a drag fights the page scroll
 * unless it is a long-press, and a page you use once per handoff does not earn a gesture
 * people have to discover.
 *
 * Deliberately importable without a Clerk session: nothing here touches auth, and the page
 * that renders it is public. Authorization is the token in the URL and nothing else.
 */
export function ScanPhoneCapture({ token }: { token: string }) {
  const [pages, setPages] = useState<ScanPage[]>([]);
  const [busy, setBusy] = useState(false);
  const [sentBatches, setSentBatches] = useState(0);
  const [finished, setFinished] = useState(false);
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
              ? "This browser can’t open that photo — try a different one?"
              : `Couldn’t read ${file.name} — try a different one?`
          );
        }
      }
      setPages((prev) => {
        const room = Math.max(0, MAX_SCAN_PAGES - prev.length);
        if (added.length > room) {
          toast.error(`That’s the ${MAX_SCAN_PAGES}-page limit for one send — send these, then add more`);
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

  function move(id: string, delta: -1 | 1) {
    setPages((prev) => {
      const from = prev.findIndex((p) => p.id === id);
      return movePage(prev, from, from + delta);
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
          files: pages.map((p) => ({ filename: p.filename, mimeType: p.mimeType, base64: p.base64 })),
        }),
      });
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        toast.error(
          body.error ??
            (res.status === 404
              ? "This link has expired — make a new QR code on your computer"
              : "Those pages didn’t send — try again?")
        );
        return;
      }
      for (const page of pages) releaseScanPage(page);
      setPages([]);
      setSentBatches((n) => n + 1);
    } catch (err) {
      // A throw from `fetch` is a connection that never reached Orbit, which #150 already
      // words as OFFLINE_MESSAGE; `friendlyError` also tells a timeout apart from it.
      toast.error(friendlyError(err, OFFLINE_MESSAGE));
    } finally {
      setBusy(false);
    }
  }

  async function finish() {
    if (busy) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/scan/${encodeURIComponent(token)}/finish`, { method: "POST" });
      if (!res.ok && res.status !== 404) {
        toast.error("Couldn’t finish — try again?");
        return;
      }
      setFinished(true);
    } catch (err) {
      toast.error(friendlyError(err, OFFLINE_MESSAGE));
    } finally {
      setBusy(false);
    }
  }

  const header = (
    <header className="flex w-full items-center gap-3">
      <Link href="/dashboard" aria-label="Open Orbit" className="shrink-0 rounded-full">
        <OrbitLogo size="sm" />
      </Link>
      <div className="min-w-0">
        <h1 className="font-heading text-lg font-medium leading-tight text-ink">Scan your notes</h1>
        <p className="text-xs text-muted-foreground">They appear on your computer as you send them.</p>
      </div>
    </header>
  );

  if (finished) {
    return (
      <div className="flex w-full flex-col gap-6">
        {header}
        <div className="flex flex-col items-center gap-3 py-8 text-center">
          <div className="grid size-14 place-items-center rounded-full bg-import-scan/15">
            <Check className="size-7 text-import-scan" />
          </div>
          <h2 className="font-heading text-xl font-medium text-ink">All sent</h2>
          <p className="text-sm text-muted-foreground">
            Finish up on your computer — your notes are already there.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-full w-full flex-col gap-5">
      {header}

      <input ref={cameraRef} type="file" accept="image/*" capture="environment" className="sr-only" onChange={onPick} />
      <input ref={rollRef} type="file" multiple accept="image/*,application/pdf,.pdf" className="sr-only" onChange={onPick} />

      {sentBatches > 0 && (
        <p className="rounded-xl bg-import-scan/10 px-3 py-2 text-center text-xs text-foreground">
          {sentBatches === 1 ? "1 batch sent" : `${sentBatches} batches sent`} — add more pages, or tap Done.
        </p>
      )}

      {pages.length > 0 ? (
        <div className="space-y-2">
          <p className="text-xs text-muted-foreground">
            {pages.length} of {MAX_SCAN_PAGES} pages · in the order they&apos;ll be read
          </p>
          <ul className="grid grid-cols-3 gap-2" aria-label="Pages to send">
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
                    className="aspect-[3/4] w-full rounded-lg border border-border/60 object-cover"
                  />
                  <span className="absolute left-1 top-1 rounded-md bg-black/60 px-1.5 py-0.5 text-[11px] font-medium text-white">
                    {i + 1}
                  </span>
                  <button
                    type="button"
                    onClick={() => discard(page.id)}
                    aria-label={`Remove page ${i + 1}`}
                    className="absolute -right-1.5 -top-1.5 grid size-7 place-items-center rounded-full border border-border bg-card text-muted-foreground shadow-sm"
                  >
                    <X className="size-4" />
                  </button>
                  <div className="absolute bottom-1 right-1 flex gap-1">
                    <button
                      type="button"
                      disabled={i === 0}
                      onClick={() => move(page.id, -1)}
                      aria-label={`Move page ${i + 1} earlier`}
                      className="grid size-7 place-items-center rounded-full bg-black/60 text-white disabled:opacity-30"
                    >
                      <ChevronLeft className="size-4" />
                    </button>
                    <button
                      type="button"
                      disabled={i === pages.length - 1}
                      onClick={() => move(page.id, 1)}
                      aria-label={`Move page ${i + 1} later`}
                      className="grid size-7 place-items-center rounded-full bg-black/60 text-white disabled:opacity-30"
                    >
                      <ChevronRight className="size-4" />
                    </button>
                  </div>
                </motion.li>
              ))}
            </AnimatePresence>
          </ul>
        </div>
      ) : (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 rounded-2xl border border-dashed border-border/70 px-4 py-10 text-center">
          <Camera className="size-8 text-muted-foreground" />
          <p className="text-sm text-muted-foreground">Photograph each page, or pick photos from your camera roll.</p>
        </div>
      )}

      {/* Thumb-reachable, above the home indicator, always in view. */}
      <div
        className="sticky bottom-0 -mx-5 mt-auto flex flex-col gap-2 border-t border-border/60 bg-background/95 px-5 pt-3 backdrop-blur"
        style={{ paddingBottom: "calc(0.75rem + env(safe-area-inset-bottom))" }}
      >
        <div className="grid grid-cols-2 gap-2">
          <Button size="lg" disabled={busy} className="h-14 bg-primary text-base text-primary-foreground hover:bg-primary/90" onClick={() => cameraRef.current?.click()}>
            <Camera className="size-5" />
            {pages.length ? "Another photo" : "Take a photo"}
          </Button>
          <Button size="lg" variant="outline" disabled={busy} className="h-14" onClick={() => rollRef.current?.click()}>
            <Images className="size-4" />
            Camera roll
          </Button>
        </div>
        {pages.length > 0 ? (
          <Button size="lg" disabled={busy} className="h-14 w-full bg-import-scan text-base text-white hover:bg-import-scan/90" onClick={() => void send()}>
            {busy ? "Sending…" : pages.length === 1 ? "Send to computer" : `Send ${pages.length} pages`}
          </Button>
        ) : sentBatches > 0 ? (
          <Button size="lg" disabled={busy} className="h-14 w-full bg-import-scan text-base text-white hover:bg-import-scan/90" onClick={() => void finish()}>
            <Check className="size-5" /> Done — I&apos;m finished
          </Button>
        ) : null}
      </div>
    </div>
  );
}
