"use client";

import { useRef, useState, type ReactElement, type ReactNode } from "react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

/** Is any `.truncate` line inside `el` (or `el` itself) cut off? */
function isClipped(el: HTMLElement | null) {
  if (!el) return false;
  const lines = [el, ...Array.from(el.querySelectorAll<HTMLElement>(".truncate"))];
  return lines.some((n) => n.classList.contains("truncate") && n.scrollWidth > n.clientWidth);
}

/**
 * Hover (or focus) a notification row and the rest of its text opens in a bubble above it.
 *
 * Rows keep their one-line `truncate` layout so the list stays scannable; the bubble is where
 * the full title and detail live. It only opens when something is actually cut off, so a
 * short notification does not grow a bubble that repeats what is already on screen.
 *
 * `render` is the element that becomes the hover target (the row's link or text block) and
 * `children` its content, exactly as they would be without the bubble.
 */
export function RowBubble({
  lines,
  render,
  children,
}: {
  /** The full text, title first. Blank lines are skipped. */
  lines: string[];
  render: ReactElement;
  children: ReactNode;
}) {
  // Typed as the trigger's default element; `render` swaps in a link or div, and all this reads is layout.
  const target = useRef<HTMLButtonElement | null>(null);
  const [open, setOpen] = useState(false);
  const shown = lines.filter((l) => l.trim() !== "");

  return (
    <Tooltip open={open} onOpenChange={(next) => setOpen(next && isClipped(target.current))}>
      <TooltipTrigger ref={target} render={render}>
        {children}
      </TooltipTrigger>
      <TooltipContent side="top" align="start" className="max-w-sm break-words">
        {shown.map((line, i) => (
          <p key={i} className={i === 0 ? "font-medium" : "mt-0.5 opacity-80"}>
            {line}
          </p>
        ))}
      </TooltipContent>
    </Tooltip>
  );
}
