"use client";

import { useEffect, useState, useTransition } from "react";
import { Moon, Sun } from "lucide-react";
import { motion, useReducedMotion } from "motion/react";
import { useTheme } from "next-themes";
import { saveThemePreference } from "@/actions/settings";
import { SPRING_PILL } from "@/lib/motion";
import { cn } from "@/lib/utils";

/**
 * The light/dark switch.
 *
 * A switch rather than an icon button: this is a two-state setting, and a 32px square that
 * swapped one glyph for another said neither which state you were in nor that there were two.
 * The track shows both destinations, the thumb sits on the one you are in, and pressing it
 * slides between them.
 *
 * `role="switch"` with `aria-checked` for the same reason — a plain button announces "button",
 * which is the shape, not the state.
 */
export function ThemeToggle({ className }: { className?: string }) {
  const { resolvedTheme, setTheme } = useTheme();
  const [mounted, setMounted] = useState(false);
  const [, start] = useTransition();
  const reducedMotion = useReducedMotion();

  useEffect(() => {
    setMounted(true);
  }, []);

  const isDark = mounted && resolvedTheme === "dark";

  function toggleTheme() {
    const next = isDark ? "light" : "dark";
    setTheme(next);
    start(async () => {
      try {
        await saveThemePreference(next);
      } catch {
        // Non-blocking — local theme still applies
      }
    });
  }

  return (
    <button
      type="button"
      role="switch"
      aria-checked={isDark}
      aria-label={isDark ? "Switch to light mode" : "Switch to dark mode"}
      onClick={toggleTheme}
      className={cn(
        "relative inline-flex h-8 w-14 shrink-0 items-center rounded-full border border-border/70 bg-muted/60 p-1",
        "transition-colors duration-(--transition-duration-base) ease-(--ease-house)",
        "hover:bg-muted focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none",
        className
      )}
    >
      {/* Both destinations, in the thumb's own two footprints, so whichever one the thumb is
          not covering reads as where pressing will take you. */}
      <span
        aria-hidden
        className="pointer-events-none absolute inset-0 flex items-center p-1 text-muted-foreground/50"
      >
        <span className="flex size-6 items-center justify-center">
          <Sun className="size-3.5" />
        </span>
        <span className="flex size-6 items-center justify-center">
          <Moon className="size-3.5" />
        </span>
      </span>

      <motion.span
        aria-hidden
        className="relative z-[1] flex size-6 items-center justify-center rounded-full bg-card text-ink shadow-sm ring-1 ring-black/[0.04] dark:ring-white/10"
        // `initial={false}` so a page that loads already in dark places the thumb rather than
        // sliding it across on arrival — the switch was not pressed, so nothing should move.
        initial={false}
        animate={{ x: isDark ? 24 : 0 }}
        transition={reducedMotion ? { duration: 0 } : SPRING_PILL}
      >
        {isDark ? <Moon className="size-3.5" /> : <Sun className="size-3.5" />}
      </motion.span>
    </button>
  );
}
