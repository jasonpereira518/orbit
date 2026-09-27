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
 * Whether an element should start hidden, waiting to be revealed.
 *
 * Only when the visitor has NOT asked for reduced motion — by EITHER signal — and the
 * element is still below the viewport. `mediaReduced` is the media query read
 * synchronously and is the one that matters on the first run: `hookReduced` comes from
 * `usePrefersReducedMotion`, which starts false and learns the real preference one render
 * late. Trusting the hook alone set reduced-motion visitors' content to "pending"; when
 * the hook then flipped, the effect's cleanup disconnected the only observer that could
 * ever reveal it, and every scroll-revealed heading, paragraph and button on the landing
 * page stayed invisible for them.
 */
export function shouldStartHidden(opts: {
  hookReduced: boolean;
  mediaReduced: boolean;
  top: number;
  viewportHeight: number;
}) {
  if (opts.hookReduced || opts.mediaReduced) return false;
  // Already on screen (or above it) at hydration: leave it alone, hiding seen content
  // would flash.
  return opts.top >= opts.viewportHeight;
}

/** What to render for `data-reveal`. The preference always wins: if reduced motion turns
 * on mid-session after an element went pending, it shows rather than waiting forever. */
export function revealAttr(state: "visible" | "pending" | "in", reduced: boolean) {
  return reduced || state === "visible" ? undefined : state;
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
    if (
      !el ||
      !shouldStartHidden({
        hookReduced: reduced,
        mediaReduced: window.matchMedia("(prefers-reduced-motion: reduce)").matches,
        top: el.getBoundingClientRect().top,
        viewportHeight: window.innerHeight,
      })
    ) {
      return;
    }

    setState("pending");
    return observe(el, () => setState("in"));
    // Once-only by design: never re-run after the first reveal.
  }, [reduced]);

  return (
    <Tag
      // Callback ref keeps one ref type across the polymorphic tag.
      ref={(node: HTMLElement | null) => {
        ref.current = node;
      }}
      data-reveal={revealAttr(state, reduced)}
      style={
        delay ? ({ "--reveal-delay": `${delay}ms` } as CSSProperties) : undefined
      }
      className={className}
    >
      {children}
    </Tag>
  );
}
