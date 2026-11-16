"use client";

/**
 * `CaptureResumeNotice`: the state /capture opens in when a fresh job is waiting on you:
 * extracted but not reviewed. Deliberately a full card rather than a banner above the input
 * UI — the cards are the thing to do next, and a paste box under them would invite starting
 * something else. `StaleDraftNotice` (bottom of the file) is the opposite: a slim banner for
 * a draft left for days, shown above the normal input UI.
 */
import { motion } from "motion/react";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { discardStaleDraft } from "@/actions/capture-jobs";
import { clearCaptureJob, useCaptureJob } from "@/lib/capture/job-store";
import { Button } from "@/components/ui/button";
import { friendlyError } from "@/lib/errors";
import { toast } from "@/lib/toast";
import { DUR, EASE_HOUSE } from "@/lib/motion";
import { PlanetBadge } from "@/components/capture/review/planet-badge";

export function CaptureResumeNotice({
  count,
  sourceLabel,
  onReview,
  onStartOver,
}: {
  count: number;
  /** "your notes", "a voice note", "a meeting" */
  sourceLabel: string;
  onReview: () => void;
  onStartOver: () => void;
}) {
  const shown = Math.min(count, 4);
  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, scale: 0.98 }}
      transition={{ duration: DUR.base, ease: EASE_HOUSE }}
      className="flex flex-col items-center gap-5 rounded-2xl border border-primary/30 bg-primary/[0.04] p-8 text-center"
    >
      <div className="flex -space-x-3">
        {Array.from({ length: shown }).map((_, i) => (
          <PlanetBadge key={i} index={i} size="sm" className="ring-2 ring-background" />
        ))}
        {count > shown && (
          <span className="grid size-10 place-items-center rounded-full bg-muted text-xs font-medium text-muted-foreground ring-2 ring-background">
            +{count - shown}
          </span>
        )}
      </div>
      <div className="space-y-1">
        <h2 className="font-[family-name:var(--font-display)] text-2xl text-ink">
          {count} {count === 1 ? "person" : "people"} ready to review
        </h2>
        <p className="text-sm text-muted-foreground">Pulled from {sourceLabel}. Pick up where you left off.</p>
      </div>
      <div className="flex flex-wrap justify-center gap-2">
        <Button size="lg" className="bg-primary text-primary-foreground hover:bg-primary/90" onClick={onReview}>
          Review {count === 1 ? "them" : "everyone"}
        </Button>
        <Button size="lg" variant="ghost" className="text-muted-foreground" onClick={onStartOver}>
          Start over
        </Button>
      </div>
    </motion.div>
  );
}

/**
 * A draft left for days: offered, never opened for you. Resume goes to `<path>?job=<id>`,
 * which the pages treat as an explicit ask (`shouldAutoOpenJob`), so it opens the summary.
 */
export function StaleDraftNotice({
  jobId,
  kind,
  updatedAt,
  itemCount,
  path,
}: {
  jobId: string;
  kind: "meeting" | "notes";
  /** ISO time the draft was last touched. */
  updatedAt: string;
  /** People already pulled out of it; more than 0 makes Discard ask first. */
  itemCount: number;
  path: "/capture" | "/meetings";
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const date = new Date(updatedAt).toLocaleDateString(undefined, { month: "short", day: "numeric" });
  // The app-wide job store may still hold this draft from another page; it must not bring
  // the old review back over the input form.
  const { job: stored } = useCaptureJob();
  useEffect(() => {
    if (stored?.id === jobId) clearCaptureJob();
  }, [stored?.id, jobId]);
  async function discard() {
    setBusy(true);
    try {
      const res = await discardStaleDraft(jobId);
      if (!res.ok) {
        toast.error(res.error);
        setBusy(false);
        return;
      }
      if (!res.discarded) toast.info("That draft was already saved");
      clearCaptureJob();
      router.refresh();
    } catch (err) {
      toast.error(friendlyError(err, "Couldn’t discard that draft — try again?"));
      setBusy(false);
    }
  }
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-primary/30 bg-primary/[0.04] px-4 py-3">
      <p className="text-sm text-ink" suppressHydrationWarning>
        Unsaved {kind} from {date}
        {itemCount > 0 ? ` · ${itemCount} ${itemCount === 1 ? "person" : "people"}` : ""}
      </p>
      <div className="flex gap-2">
        {confirming ? (
          <>
            <Button size="sm" variant="destructive" disabled={busy} onClick={() => void discard()}>
              Yes, discard
            </Button>
            <Button size="sm" variant="ghost" className="text-muted-foreground" disabled={busy} onClick={() => setConfirming(false)}>
              Keep it
            </Button>
          </>
        ) : (
          <>
            <Button size="sm" disabled={busy} onClick={() => router.push(`${path}?job=${jobId}`)}>
              Resume
            </Button>
            <Button
              size="sm"
              variant="ghost"
              className="text-muted-foreground"
              disabled={busy}
              onClick={() => (itemCount > 0 ? setConfirming(true) : void discard())}
            >
              Discard
            </Button>
          </>
        )}
      </div>
    </div>
  );
}
