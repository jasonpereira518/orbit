"use client";

/**
 * The state /capture opens in when a job is waiting on you: extracted but not reviewed.
 * Deliberately a full card rather than a banner above the input UI — the cards are the
 * thing to do next, and a paste box under them would invite starting something else.
 */
import { motion } from "motion/react";
import { Button } from "@/components/ui/button";
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
