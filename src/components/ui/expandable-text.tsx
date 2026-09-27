"use client";

import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";

/** Truncates long text with a See more / See less control when it overflows. */
export function ExpandableText({
  text,
  lines = 2,
  className,
  buttonClassName,
  onLayoutChange,
}: {
  text: string;
  lines?: 2 | 3 | 4;
  className?: string;
  buttonClassName?: string;
  /**
   * Called after the rendered height changes — the See more control appearing once
   * overflow is measured, or the text expanding and collapsing. For containers that
   * size themselves from a one-off measurement: a toast, which sonner measures once
   * and then locks to that height while the stack is hovered.
   */
  onLayoutChange?: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [overflows, setOverflows] = useState(false);
  const ref = useRef<HTMLParagraphElement>(null);

  // Held in a ref so a new callback identity never re-fires the effect below — only a
  // real change in layout does.
  const onLayoutChangeRef = useRef(onLayoutChange);
  useEffect(() => {
    onLayoutChangeRef.current = onLayoutChange;
  });
  const hasRendered = useRef(false);
  useEffect(() => {
    if (!hasRendered.current) {
      hasRendered.current = true;
      return;
    }
    onLayoutChangeRef.current?.();
  }, [expanded, overflows]);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    function measure() {
      if (!el || expanded) return;
      setOverflows(el.scrollHeight > el.clientHeight + 1);
    }

    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [text, lines, expanded]);

  const clampClass =
    lines === 4
      ? "line-clamp-4"
      : lines === 3
        ? "line-clamp-3"
        : "line-clamp-2";

  return (
    <div className="min-w-0">
      <p
        ref={ref}
        className={cn(
          "text-sm text-muted-foreground whitespace-pre-wrap break-words",
          !expanded && clampClass,
          className
        )}
      >
        {text}
      </p>
      {(overflows || expanded) && (
        <button
          type="button"
          className={cn(
            "mt-0.5 text-xs font-medium text-primary underline-offset-2 hover:underline",
            buttonClassName
          )}
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            setExpanded((v) => !v);
          }}
        >
          {expanded ? "See less" : "See more"}
        </button>
      )}
    </div>
  );
}
