"use client";

/**
 * What the page shows between Extract and the first card: a small orbit, the words for
 * what is happening, and — once the result is in — a beat of "Found 3 people" before the
 * deck slides in. Pure CSS for the orbit so it keeps turning pre-hydration and in a hidden
 * tab; `motion-reduce:animate-none` is the whole reduced-motion story.
 */
import { motion } from "motion/react";
import { DUR, EASE_HOUSE } from "@/lib/motion";
import { cn } from "@/lib/utils";

export function ExtractingStage({
  phase,
  foundCount,
  meta,
  error,
  onRetry,
  onStartOver,
}: {
  phase: "reading" | "found" | "failed";
  foundCount?: number | null;
  /** What is being read — a filename, "3 pages", "Voice note · 1:24". */
  meta?: string | null;
  error?: string | null;
  onRetry?: () => void;
  onStartOver?: () => void;
}) {
  const heading =
    phase === "failed"
      ? "Couldn’t read those notes"
      : phase === "found"
        ? foundCount === 0
          ? "No one to review"
          : `Found ${foundCount} ${foundCount === 1 ? "person" : "people"}`
        : "Reading your notes…";
  return (
    <motion.div
      role="status"
      aria-live="polite"
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, scale: 0.96 }}
      transition={{ duration: DUR.base, ease: EASE_HOUSE }}
      className="flex min-h-[22rem] flex-col items-center justify-center gap-5 rounded-2xl border border-border/70 bg-card p-8 text-center"
    >
      <OrbitSpinner done={phase !== "reading"} failed={phase === "failed"} />
      <div className="space-y-1.5">
        <h2 className="font-[family-name:var(--font-display)] text-2xl text-ink">{heading}</h2>
        <p className="text-sm text-muted-foreground">
          {phase === "failed"
            ? error
            : phase === "found"
              ? "Setting up your cards"
              : meta
                ? `Reading ${meta}`
                : "Pulling out each person, and anything with a date on it"}
        </p>
      </div>
      {phase === "reading" && (
        <p className="max-w-sm text-xs text-muted-foreground">
          This keeps going if you leave the page — you can come back to it from the bell.
        </p>
      )}
      {phase === "failed" && (
        <div className="flex flex-wrap justify-center gap-2">
          {onRetry && (
            <button type="button" onClick={onRetry} className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90">
              Try again
            </button>
          )}
          {onStartOver && (
            <button type="button" onClick={onStartOver} className="rounded-md border border-border px-4 py-2 text-sm font-medium text-foreground hover:bg-muted">
              Start over
            </button>
          )}
        </div>
      )}
    </motion.div>
  );
}

function OrbitSpinner({ done, failed }: { done: boolean; failed: boolean }) {
  return (
    <div className="relative size-14" aria-hidden>
      <div className={cn("absolute inset-0 rounded-full border border-border/70", failed && "border-destructive/40")} />
      <div className={cn("absolute inset-[38%] rounded-full bg-primary/80", failed && "bg-destructive/70")} />
      <div className={cn("absolute inset-0 motion-reduce:animate-none", !done && "animate-spin [animation-duration:1.8s]")}>
        <div className={cn("absolute -top-1 left-1/2 size-2.5 -translate-x-1/2 rounded-full bg-primary shadow-[0_0_8px_var(--color-primary)]", failed && "bg-destructive shadow-none")} />
      </div>
    </div>
  );
}
