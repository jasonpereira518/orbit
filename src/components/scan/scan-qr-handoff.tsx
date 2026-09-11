"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { toast } from "@/lib/toast";
import { DUR, EASE_HOUSE } from "@/lib/motion";
import { usePrefersReducedMotion } from "@/lib/use-prefers-reduced-motion";
import {
  cancelScanHandoffAction,
  mintScanHandoffAction,
  pollScanHandoffAction,
  type MintedScanHandoff,
} from "@/actions/scan";

/** Matches `POLL_INTERVAL_MS` in `import-job-runner.ts`, so the app polls at one cadence. */
const POLL_INTERVAL_MS = 1500;

function formatRemaining(ms: number) {
  const total = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

/**
 * "Send it from your phone": a QR code, and a live view of what the phone is doing.
 *
 * The phone that scans this has no Clerk session and never gets one — signing into a CRM
 * on a phone keyboard is the friction this whole path exists to remove. The grant behind
 * the code is single-use and expires in ten minutes; see `src/lib/scan-handoff.ts`.
 */
export function ScanQrHandoff({
  active = true,
  onTranscript,
  onCancel,
}: {
  /**
   * Whether the code should be live. Goes false the instant the host starts closing.
   *
   * Same reasoning as `ScanCamera`'s `active`: this renders in a dialog, and a dialog only
   * unmounts after its exit animation, which a hidden tab never advances. Cancelling on
   * unmount would leave a code "closed" on screen but still redeemable, and still polled.
   */
  active?: boolean;
  onTranscript: (result: { transcript: string; sources: string[] }) => void;
  onCancel: () => void;
}) {
  const [handoff, setHandoff] = useState<MintedScanHandoff | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [phase, setPhase] = useState<"waiting" | "uploading">("waiting");
  const [remaining, setRemaining] = useState<number>(0);
  const reduced = usePrefersReducedMotion();

  // Kept in a ref so the poll and the unmount cleanup always see the live token without
  // making either of them depend on state that would restart the interval.
  const tokenRef = useRef<string | null>(null);
  const doneRef = useRef(false);

  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    (async () => {
      const res = await mintScanHandoffAction();
      if (cancelled) {
        // Closed before the code came back: nobody will ever scan this one, so it must
        // not sit redeemable for ten minutes. (Also what stops a dev-mode StrictMode
        // double-mount from leaking a live grant.)
        if (res.ok) void cancelScanHandoffAction(res.handoff.token);
        return;
      }
      if (!res.ok) {
        setError(res.error);
        return;
      }
      tokenRef.current = res.handoff.token;
      setHandoff(res.handoff);
    })();
    return () => {
      // Runs when `active` goes false AND on unmount. A code left on a closed card must
      // not stay redeemable — and clearing the ref is what stops the poll, which bails
      // without a token.
      cancelled = true;
      if (!doneRef.current && tokenRef.current) {
        void cancelScanHandoffAction(tokenRef.current);
      }
      tokenRef.current = null;
    };
  }, [active]);

  // Expiry countdown. Its own interval, not the poll's, so the clock stays smooth even if
  // a poll is slow.
  useEffect(() => {
    if (!handoff) return;
    const expiry = new Date(handoff.expiresAtIso).getTime();
    const tick = () => setRemaining(expiry - Date.now());
    tick();
    const id = window.setInterval(tick, 1000);
    return () => window.clearInterval(id);
  }, [handoff]);

  const finish = useCallback(
    (transcript: string, sources: string[]) => {
      doneRef.current = true;
      onTranscript({ transcript, sources });
    },
    [onTranscript]
  );

  useEffect(() => {
    if (!handoff) return;
    let stopped = false;

    const id = window.setInterval(async () => {
      const token = tokenRef.current;
      if (!token || stopped || doneRef.current) return;

      const res = await pollScanHandoffAction(token);
      if (stopped || doneRef.current) return;
      if (!res.ok) return; // A transient failure is not worth tearing the card down for.

      const claim = res.claim;
      if (claim.state === "uploading") {
        setPhase("uploading");
      } else if (claim.state === "error") {
        toast.error(claim.message);
        setPhase("waiting");
      } else if (claim.state === "expired") {
        stopped = true;
        setError("That code expired. Generate a new one.");
      } else if (claim.state === "ready") {
        stopped = true;
        finish(claim.transcript, claim.sources ? [claim.sources] : []);
      }
    }, POLL_INTERVAL_MS);

    return () => {
      stopped = true;
      window.clearInterval(id);
    };
  }, [handoff, finish]);

  const expired = handoff !== null && remaining <= 0;

  if (error || expired) {
    return (
      <div className="space-y-3 text-center">
        <p className="text-sm text-muted-foreground">
          {error ?? "That code expired."}
        </p>
        <Button size="sm" variant="outline" onClick={onCancel}>
          Close
        </Button>
      </div>
    );
  }

  return (
    // No border of its own: this renders inside a dialog, which is already the frame.
    <div className="flex flex-col items-center gap-3 text-center">
      {handoff ? (
        <div
          // The SVG's fill is `currentColor`, so the code follows the theme instead of
          // vanishing into a dark card.
          className="w-40 text-ink [&>svg]:h-auto [&>svg]:w-full"
          aria-label="QR code linking to the phone camera page"
          role="img"
          dangerouslySetInnerHTML={{ __html: handoff.svg }}
        />
      ) : (
        <Skeleton className="size-40 rounded-lg" />
      )}

      <div className="space-y-1">
        {/*
          A live region, and a crossfade rather than a layout change: the line sits under
          the person's eye while they look at their phone, and a jump would pull it back.
        */}
        <div aria-live="polite" className="h-5 text-xs text-muted-foreground">
          <AnimatePresence mode="wait" initial={false}>
            <motion.p
              key={phase}
              initial={reduced ? false : { opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={reduced ? undefined : { opacity: 0 }}
              transition={{ duration: DUR.base, ease: EASE_HOUSE }}
            >
              {phase === "uploading"
                ? "Phone connected — reading your pages…"
                : "Waiting for your phone…"}
            </motion.p>
          </AnimatePresence>
        </div>
        {handoff && (
          <p className="text-xs text-muted-foreground/70">
            Link expires in {formatRemaining(remaining)}
          </p>
        )}
      </div>

      <Button size="sm" variant="ghost" onClick={onCancel}>
        Cancel
      </Button>
    </div>
  );
}
