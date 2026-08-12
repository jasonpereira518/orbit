"use client";

import { useEffect, useState } from "react";
import { ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";

function prefersReducedMotion() {
  if (typeof window === "undefined") return false;
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/**
 * Pins the very first scroll on the page: the hero can't be scrolled away
 * until the visitor tries to scroll (which reveals a "next section" arrow)
 * and clicks it. After that one gate, scrolling is unlocked for good —
 * this never re-locks. Skipped entirely under prefers-reduced-motion,
 * where trapping scroll would be a real accessibility cost for no payoff.
 */
export function LandingScrollGate({ targetId }: { targetId: string }) {
  const [locked, setLocked] = useState(true);
  const [revealed, setRevealed] = useState(false);

  useEffect(() => {
    if (prefersReducedMotion()) {
      setLocked(false);
      return;
    }
    if (!locked) return;

    function reveal() {
      setRevealed(true);
    }

    function onWheel(e: WheelEvent) {
      if (e.deltaY > 0) {
        e.preventDefault();
        reveal();
      }
    }

    function onTouchMove(e: TouchEvent) {
      e.preventDefault();
      reveal();
    }

    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "ArrowDown" || e.key === "PageDown" || e.key === " ") {
        e.preventDefault();
        reveal();
      }
    }

    window.addEventListener("wheel", onWheel, { passive: false });
    window.addEventListener("touchmove", onTouchMove, { passive: false });
    window.addEventListener("keydown", onKeyDown);

    return () => {
      window.removeEventListener("wheel", onWheel);
      window.removeEventListener("touchmove", onTouchMove);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [locked]);

  function handleAdvance() {
    setLocked(false);
    document.getElementById(targetId)?.scrollIntoView({ behavior: "smooth" });
  }

  if (!locked) return null;

  return (
    <button
      type="button"
      onClick={handleAdvance}
      aria-label="Scroll to the next section"
      className={cn(
        "fixed bottom-8 left-1/2 z-20 -translate-x-1/2 rounded-full border border-white/15 bg-white/5 p-3 text-[#e8f3f1] backdrop-blur-sm transition-all duration-300 hover:border-white/30 hover:bg-white/10",
        revealed
          ? "translate-y-0 opacity-100"
          : "pointer-events-none translate-y-2 opacity-0"
      )}
    >
      <ChevronDown className="h-5 w-5 animate-bounce" aria-hidden="true" />
    </button>
  );
}
