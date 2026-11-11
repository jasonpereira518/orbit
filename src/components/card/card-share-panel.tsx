"use client";

import { useEffect, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Copy, Maximize2, RotateCcw, Share2 } from "lucide-react";
import { toast } from "sonner";
import { resetMyCardLink, setMyCardPaused } from "@/actions/cards";
import { CardQr } from "@/components/card/card-qr";
import { Button, buttonVariants } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { friendlyError } from "@/lib/errors";
import { TOAST_COPY } from "@/lib/toast-copy";
import { cn } from "@/lib/utils";

/** The owner's card, ready to hand over: QR, link, share, full screen, reset and pause. */
export function CardSharePanel({ url, svg, paused }: { url: string; svg: string; paused: boolean }) {
  const router = useRouter();
  const [confirmReset, setConfirmReset] = useState(false);
  const [pending, start] = useTransition();

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(url);
      toast.success("Link copied");
    } catch {
      toast.error("Couldn’t copy the link — select it and copy it yourself");
    }
  };

  const share = async () => {
    if (!navigator.share) return copy();
    try {
      await navigator.share({ title: "My contact card", url });
    } catch (err) {
      // Closing the share sheet is not a failure.
      if ((err as Error)?.name !== "AbortError") await copy();
    }
  };

  const run = (action: () => Promise<{ ok: true } | { ok: false; message: string }>, done: string) =>
    start(async () => {
      try {
        const res = await action();
        if (!res.ok) {
          toast.error(res.message);
          return;
        }
        toast.success(done);
        setConfirmReset(false);
        router.refresh();
      } catch (err) {
        toast.error(friendlyError(err, TOAST_COPY.saveFailed));
      }
    });

  return (
    <div className="flex flex-col items-center gap-5 md:flex-row md:items-start md:gap-8">
      <CardQr svg={svg} className={cn("w-56 shrink-0", paused && "opacity-40")} />
      <div className="flex w-full min-w-0 flex-col gap-4">
        <p className="break-all text-sm text-muted-foreground">{url}</p>
        {paused && (
          <p className="text-sm text-warning">Your card is paused — the link shows nothing until you turn it back on.</p>
        )}
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" onClick={copy}>
            <Copy aria-hidden />
            Copy link
          </Button>
          <Button variant="outline" onClick={share}>
            <Share2 aria-hidden />
            Share
          </Button>
          <Link href="/card/show" className={buttonVariants()}>
            <Maximize2 aria-hidden />
            Show full screen
          </Link>
        </div>
        <div className="flex flex-wrap items-center gap-x-6 gap-y-3 border-t border-border/60 pt-4">
          <label className="flex items-center gap-2.5 text-sm">
            <button
              type="button"
              role="switch"
              aria-checked={paused}
              disabled={pending}
              onClick={() => run(() => setMyCardPaused(!paused), paused ? "Card is back on" : "Card paused")}
              className={cn(
                "tap-target relative inline-flex h-5 w-9 shrink-0 items-center rounded-full outline-none transition-colors focus-visible:ring-3 focus-visible:ring-ring/50 disabled:opacity-50",
                paused ? "bg-primary" : "bg-muted-foreground/30"
              )}
            >
              <span
                aria-hidden
                className={cn("size-4 rounded-full bg-background shadow-sm transition-transform", paused ? "translate-x-[1.125rem]" : "translate-x-0.5")}
              />
            </button>
            Pause my card
          </label>
          <Button variant="ghost" size="sm" onClick={() => setConfirmReset(true)}>
            <RotateCcw aria-hidden />
            Reset link
          </Button>
        </div>
      </div>

      <Dialog open={confirmReset} onOpenChange={setConfirmReset}>
        <DialogContent showCloseButton={false} className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Reset your card link?</DialogTitle>
            <DialogDescription>Printed codes and NFC stickers with the old link will stop working.</DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-2 sm:gap-2">
            <Button variant="outline" onClick={() => setConfirmReset(false)} disabled={pending}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={() => run(resetMyCardLink, "New link ready")} disabled={pending}>
              Reset link
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

/** Keeps the screen on while the code is up, where the browser allows it. */
export function KeepScreenAwake() {
  useEffect(() => {
    if (!("wakeLock" in navigator)) return;
    let alive = true;
    let lock: WakeLockSentinel | null = null;
    const release = () => {
      void lock?.release().catch(() => null);
      lock = null;
    };
    const acquire = async () => {
      if (document.visibilityState !== "visible") return;
      try {
        const next = await navigator.wakeLock.request("screen");
        if (alive) lock = next;
        else void next.release().catch(() => null);
      } catch {
        // Denied (battery saver, no user gesture yet): the screen just dims as usual.
      }
    };
    // The browser drops the lock when the tab hides; take it again on return.
    const onVisibility = () => (document.visibilityState === "visible" ? void acquire() : release());
    void acquire();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      alive = false;
      document.removeEventListener("visibilitychange", onVisibility);
      release();
    };
  }, []);
  return null;
}
