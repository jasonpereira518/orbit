"use client";

import { useEffect, useState, useTransition } from "react";
import { Monitor, Moon, Sun } from "lucide-react";
import { motion, useReducedMotion } from "motion/react";
import { useTheme } from "next-themes";
import { saveThemePreference } from "@/actions/settings";
import { Button } from "@/components/ui/button";
import { DUR, EASE_HOUSE } from "@/lib/motion";
import type { ThemePreference } from "@/lib/theme";
import { cn } from "@/lib/utils";

/**
 * The theme control in the chrome.
 *
 * A button, not a switch. It cycles through the same three choices the appearance setting
 * offers — light → dark → system — through the same `setTheme` and `saveThemePreference`,
 * so pressing it never overwrites a saved "system" with a plain "light" the way a two-way
 * toggle did. The icon is the DESTINATION, not the current state: a moon means pressing
 * this gets you dark, a monitor means it hands the choice to the OS. Which theme you are in
 * is not information the button has to carry — the whole page is already the answer.
 *
 * Hence a plain button rather than `role="switch"` too. It announces the action ("Switch to
 * dark mode, button") where a switch announced a state the page itself states more loudly.
 */
const ORDER: readonly ThemePreference[] = ["light", "dark", "system"];

const DESTINATION: Record<ThemePreference, { icon: typeof Sun; label: string }> = {
  light: { icon: Sun, label: "Switch to light mode" },
  dark: { icon: Moon, label: "Switch to dark mode" },
  system: { icon: Monitor, label: "Match the system theme" },
};

function isPreference(value: string | undefined): value is ThemePreference {
  return value === "light" || value === "dark" || value === "system";
}

export function ThemeToggle({ className }: { className?: string }) {
  const { theme, setTheme } = useTheme();
  const [mounted, setMounted] = useState(false);
  const [, start] = useTransition();
  const reducedMotion = useReducedMotion();

  useEffect(() => {
    setMounted(true);
  }, []);

  // next-themes reads localStorage, so `theme` is unknown until mount; the server render
  // matches the provider's default so the first paint and hydration agree.
  const current: ThemePreference = mounted && isPreference(theme) ? theme : "light";
  const next = ORDER[(ORDER.indexOf(current) + 1) % ORDER.length];

  function cycleTheme() {
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
      // Outline, not ghost. In the mobile sheet the control sits alone in a footer row with
      // nothing beside it to read as an affordance — a bare glyph there is a decoration
      // until you happen to press it. It also puts this in the same square as the
      // notification bell.
      variant="outline"
      size="icon"
      aria-label={DESTINATION[next].label}
      onClick={cycleTheme}
      className={cn(
        "relative rounded-full border-border-subtle text-muted-foreground hover:text-ink",
        className
      )}
    >
      {/* All three glyphs stay mounted and stacked, so the swap is a cross-fade in place
          rather than one icon being exchanged for another — and the button cannot reflow
          mid-press. `absolute` on each, because a stack is the only way none can push the
          others around while they overlap. */}
      {ORDER.map((pref) => (
        <ThemeIcon
          key={pref}
          icon={DESTINATION[pref].icon}
          show={pref === next}
          reduced={reducedMotion}
        />
      ))}
    </Button>
  );
}

/**
 * One glyph of the stack, fading and turning into or out of place.
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
