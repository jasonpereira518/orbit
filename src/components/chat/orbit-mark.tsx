"use client";

import { motion } from "motion/react";
import { cn } from "@/lib/utils";

/**
 * The one brand touch: a dot on an orbit, rather than a generic spinner.
 *
 * Originally local to `ChatActivity`'s live step list; pulled out so every place chat shows
 * "the model is working" — the pre-first-token "Starting…" state and the ask bar's own send
 * button while a request is in flight — uses the same orbit-themed glyph instead of some of
 * them falling back to lucide's generic `Loader2`.
 *
 * Reduced motion gets a static ring instead of stopping at a random frame — the decision is
 * made at render time because `usePrefersReducedMotion` reports false on its first render,
 * and an effect that hid this and bailed would strand the indicator entirely.
 */
export function OrbitMark({
  reduceMotion,
  className,
  /**
   * "primary" (default) is always brand-primary, for the muted-foreground text this started
   * on. "current" inherits `currentColor` instead — for a spot like the ask bar's send
   * button, which sits ON a primary-colored background and needs the mark drawn in
   * `text-primary-foreground` to stay visible rather than disappearing into it.
   */
  tone = "primary",
}: {
  reduceMotion: boolean;
  className?: string;
  tone?: "primary" | "current";
}) {
  const ring = tone === "current" ? "border-current/30" : "border-primary/30";
  const dot = tone === "current" ? "bg-current" : "bg-primary";
  return (
    <span
      className={cn("relative inline-flex size-3.5 shrink-0 items-center justify-center", className)}
      aria-hidden="true"
    >
      <span className={cn("absolute inset-0 rounded-full border", ring)} />
      {reduceMotion ? (
        <span className={cn("absolute right-0 top-1/2 size-1 -translate-y-1/2 rounded-full", dot)} />
      ) : (
        <motion.span
          className="absolute inset-0"
          animate={{ rotate: 360 }}
          transition={{ duration: 1.6, ease: "linear", repeat: Infinity }}
        >
          <span className={cn("absolute right-0 top-1/2 size-1 -translate-y-1/2 rounded-full", dot)} />
        </motion.span>
      )}
    </span>
  );
}
