"use client";

import { useEffect, useRef, useState, type CSSProperties } from "react";
import { usePrefersReducedMotion } from "@/lib/use-prefers-reduced-motion";

/** One shared observer for every <Reveal> on the page. */
let observer: IntersectionObserver | null = null;
const callbacks = new WeakMap<Element, () => void>();

function observe(el: Element, cb: () => void) {
  if (!observer) {
    observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          callbacks.get(entry.target)?.();
          observer?.unobserve(entry.target);
          callbacks.delete(entry.target);
        }
      },
      { threshold: 0.15, rootMargin: "0px 0px -10% 0px" }
    );
  }
  callbacks.set(el, cb);
  observer.observe(el);
  return () => {
    observer?.unobserve(el);
    callbacks.delete(el);
  };
}

/**
 * Scroll-triggered fade+rise for below-the-fold sections.
 *
 * Progressive enhancement only: the server renders children fully visible, so
 * nothing is hidden if JS is slow or absent. On hydration, elements still
 * below the viewport are hidden and revealed once (per mount) as they enter.
 * Reduced motion disables the whole behavior.
 */
export function Reveal({
  as: Tag = "div",
  delay = 0,
  className,
  children,
}: {
  as?: "div" | "section" | "li";
  delay?: number;
  className?: string;
  children: React.ReactNode;
}) {
  const ref = useRef<HTMLElement | null>(null);
  const reduced = usePrefersReducedMotion();
  const [state, setState] = useState<"visible" | "pending" | "in">("visible");

  useEffect(() => {
    const el = ref.current;
    if (!el || reduced) return;
    // Already on screen (or above it) at hydration — leave it alone; hiding
    // seen content would flash.
    const rect = el.getBoundingClientRect();
    if (rect.top < window.innerHeight) return;

    setState("pending");
    return observe(el, () => setState("in"));
    // Once-only by design: never re-run after the first reveal.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reduced]);

  return (
    <Tag
      // Callback ref keeps one ref type across the polymorphic tag.
      ref={(node: HTMLElement | null) => {
        ref.current = node;
      }}
      data-reveal={state === "visible" ? undefined : state}
      style={
        delay ? ({ "--reveal-delay": `${delay}ms` } as CSSProperties) : undefined
      }
      className={className}
    >
      {children}
    </Tag>
  );
}
