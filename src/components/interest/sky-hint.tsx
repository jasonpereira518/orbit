"use client";

import { useEffect, useRef, useState } from "react";
import { X } from "lucide-react";
import { STARFIELD_FIGURE_EVENT, type StarfieldFigureDetail } from "@/lib/starfield-events";
import { cn } from "@/lib/utils";

const SEEN_KEY = "waitlist-sky-hint-seen";
/** Time on the page, after the pointer first moves, before the hint appears. */
const SHOW_AFTER_MS = 7000;
/** How long an unanswered hint stays up. */
const SHOW_FOR_MS = 14000;
/** How long "you found one" stays up. */
const FOUND_FOR_MS = 3500;
/** How long the explanation of a figure found by accident stays up. */
const EXPLAIN_FOR_MS = 5500;

function seen() {
  try {
    return window.localStorage.getItem(SEEN_KEY) === "1";
  } catch {
    return false;
  }
}

function markSeen() {
  try {
    window.localStorage.setItem(SEEN_KEY, "1");
  } catch {
    // Blocked storage: the hint may come back next visit. Harmless.
  }
}

/**
 * A one-time hint that the waitlist's sky is interactive: rest the cursor on it and it
 * finds and names a real constellation (`starfield.tsx`). Almost nobody would discover
 * that on their own.
 *
 * Only where the feature exists — a hovering fine pointer, motion allowed — and once per
 * device, in one of two ways:
 * - the sky finds a figure before any hint (a cursor resting while someone reads is
 *   enough): the pill explains what just happened, naming the figure;
 * - a few seconds of moving around with no figure yet: the pill suggests resting the
 *   cursor, and if a figure then appears, answers with its name.
 * Either way it leaves on its own. Nothing loops; the fade is a CSS transition.
 */
export function SkyHint() {
  const [open, setOpen] = useState(false);
  /** Which message; kept while it fades out so the words don't change mid-fade. */
  const [kind, setKind] = useState<"hint" | "found" | "explain">("hint");
  const [figure, setFigure] = useState("");
  /** Kept after it hides, so the pill fades out with its words instead of vanishing. */
  const [everShown, setEverShown] = useState(false);
  /** Dismissed by hand: nothing more from this pill, figure or not. */
  const dismissed = useRef(false);

  useEffect(() => {
    const capable =
      window.matchMedia("(hover: hover) and (pointer: fine)").matches &&
      !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (!capable || seen()) return;

    let showTimer = 0;
    let hideTimer = 0;
    let shown = false;

    const hideAfter = (ms: number) => {
      window.clearTimeout(hideTimer);
      hideTimer = window.setTimeout(() => setOpen(false), ms);
    };

    const onMove = () => {
      window.removeEventListener("pointermove", onMove);
      showTimer = window.setTimeout(() => {
        shown = true;
        markSeen();
        setEverShown(true);
        setKind("hint");
        setOpen(true);
        hideAfter(SHOW_FOR_MS);
      }, SHOW_AFTER_MS);
    };

    const onFigure = (e: Event) => {
      const { name } = (e as CustomEvent<StarfieldFigureDetail>).detail;
      markSeen();
      if (dismissed.current) return;
      window.clearTimeout(showTimer);
      window.removeEventListener("pointermove", onMove);
      // Before any hint, the figure appeared by accident: say what it was.
      const answering = shown;
      shown = true;
      setFigure(name);
      setEverShown(true);
      setKind(answering ? "found" : "explain");
      setOpen(true);
      hideAfter(answering ? FOUND_FOR_MS : EXPLAIN_FOR_MS);
      window.removeEventListener(STARFIELD_FIGURE_EVENT, onFigure);
    };

    window.addEventListener("pointermove", onMove, { passive: true });
    window.addEventListener(STARFIELD_FIGURE_EVENT, onFigure);
    return () => {
      window.clearTimeout(showTimer);
      window.clearTimeout(hideTimer);
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener(STARFIELD_FIGURE_EVENT, onFigure);
    };
  }, []);

  return (
    <div
      role="status"
      aria-live="polite"
      className={cn(
        "pointer-events-none fixed bottom-6 left-6 z-30 transition-[opacity,translate] duration-500 ease-[cubic-bezier(0.22,1,0.36,1)]",
        open ? "translate-y-0 opacity-100" : "translate-y-2 opacity-0"
      )}
    >
      {everShown ? (
        <div
          inert={!open}
          className="pointer-events-auto flex items-center gap-2.5 rounded-full border border-[#f2c14e]/25 bg-[#0b1120]/90 py-2 pl-3.5 pr-2 text-sm text-[#e8f3f1] shadow-[0_12px_32px_-12px_rgba(0,0,0,0.8)]"
        >
          <span aria-hidden="true" className="text-[#f2c14e]">
            ✦
          </span>
          {kind === "found" ? (
            <span>
              <span className="text-[#f2c14e]">{figure}</span> — you found one.
            </span>
          ) : kind === "explain" ? (
            <span>
              <span className="text-[#f2c14e]">{figure}</span> — the sky names the constellations under
              your cursor.
            </span>
          ) : (
            <span>Rest your cursor on the sky. It knows the constellations.</span>
          )}
          <button
            type="button"
            onClick={() => {
              dismissed.current = true;
              setOpen(false);
            }}
            aria-label="Dismiss"
            className="ml-1 flex size-6 items-center justify-center rounded-full text-[#9aada8] transition-colors hover:bg-[#e8f3f1]/10 hover:text-[#e8f3f1]"
          >
            <X className="size-3.5" aria-hidden="true" />
          </button>
        </div>
      ) : null}
    </div>
  );
}
