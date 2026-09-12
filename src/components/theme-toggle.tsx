"use client";

import { useEffect, useState, useTransition } from "react";
import { Moon, Sun } from "lucide-react";
import { motion, useReducedMotion } from "motion/react";
import { useTheme } from "next-themes";
import { saveThemePreference } from "@/actions/settings";
import { Button } from "@/components/ui/button";
import { DUR, EASE_HOUSE } from "@/lib/motion";
import { cn } from "@/lib/utils";

/**
 * The light/dark control.
 *
 * A button, not a switch. The track showed both destinations at once, which is honest about
 * there being two — but it spent a 56px pill on a setting most people press once, and sat in
 * the sidebar header and the mobile sheet next to controls that are all square icon buttons,
 * so the one form control in the chrome read as something you were being asked to fill in.
 *
 * The icon is the DESTINATION, not the current state: a moon means pressing this gets you
 * dark. Which of the two you are in is not information the button has to carry — the whole
 * page is already the answer — so the glyph is free to say what the press does instead.
 *
 * Hence a plain `<button>` rather than `role="switch"` too. It announces "Switch to dark mode,
 * button" — the action — where the switch announced a state that the page itself states more
 * loudly than any control could.
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
    <Button
      type="button"
      // Outline, not ghost. The switch it replaces carried its own border and muted fill, and
      // in the mobile sheet the control sits alone in a footer row with nothing beside it to
      // read as an affordance — a bare glyph there is a decoration until you happen to press
      // it. It also puts this in the same square as the notification bell, which is the point
      // of dropping the pill.
      variant="outline"
      size="icon"
      aria-label={isDark ? "Switch to light mode" : "Switch to dark mode"}
      onClick={toggleTheme}
      className={cn(
        "relative rounded-full border-border/70 text-muted-foreground hover:text-ink",
        className
      )}
    >
      {/* Both glyphs stay mounted and stacked, so the swap is a cross-fade in place rather
          than one icon being exchanged for another — and the button cannot reflow mid-press.
          `absolute` on both, because a stack of two is the only way neither can push the
          other around while they overlap. */}
      <ThemeIcon icon={Sun} show={isDark} reduced={reducedMotion} />
      <ThemeIcon icon={Moon} show={!isDark} reduced={reducedMotion} />
    </Button>
  );
}

/**
 * One glyph of the pair, fading and turning into or out of place.
 *
 * The rotation is what stops the cross-fade reading as a dissolve: a sun and a moon at the
 * same size in the same spot are similar enough that opacity alone looks like a rendering
 * glitch, while a quarter-turn says one thing left and another arrived.
 */
function ThemeIcon({
  icon: Icon,
  show,
  reduced,
}: {
  icon: typeof Sun;
  show: boolean;
  reduced: boolean | null;
}) {
  return (
    <motion.span
      aria-hidden
      className="absolute inset-0 flex items-center justify-center"
      // `initial={false}` so the theme the page loaded in is simply drawn, not animated into
      // — nothing was pressed, so nothing should move.
      initial={false}
      animate={{
        opacity: show ? 1 : 0,
        rotate: reduced ? 0 : show ? 0 : -90,
        scale: reduced ? 1 : show ? 1 : 0.6,
      }}
      transition={
        reduced ? { duration: 0 } : { duration: DUR.slow, ease: EASE_HOUSE }
      }
      // The hidden glyph must not swallow the press, and `opacity: 0` alone still would.
      style={{ pointerEvents: "none" }}
    >
      <Icon className="size-4" />
    </motion.span>
  );
}
