"use client";

import { useEffect, useRef, useState, type ComponentType } from "react";

const DESKTOP_QUERY = "(min-width: 768px)";

/**
 * The waitlist's product preview. It holds a fixed-height slot so nothing shifts, and only
 * fetches the demo — a separate chunk — once the viewport is desktop-sized AND the slot is
 * near the screen. Phones never download it; the page hides the section below `md` too.
 */
export function AppDemo() {
  const slotRef = useRef<HTMLDivElement>(null);
  const [Demo, setDemo] = useState<ComponentType | null>(null);

  useEffect(() => {
    const slot = slotRef.current;
    if (!slot) return;
    const mq = window.matchMedia(DESKTOP_QUERY);
    let io: IntersectionObserver | null = null;
    let cancelled = false;

    const arm = () => {
      if (!mq.matches || io) return;
      io = new IntersectionObserver(
        (entries) => {
          if (!entries.some((e) => e.isIntersecting)) return;
          io?.disconnect();
          void import("./demo-window").then((m) => {
            if (!cancelled) setDemo(() => m.DemoWindow);
          });
        },
        { rootMargin: "600px 0px" }
      );
      io.observe(slot);
    };

    arm();
    mq.addEventListener("change", arm);
    return () => {
      cancelled = true;
      io?.disconnect();
      mq.removeEventListener("change", arm);
    };
  }, []);

  return (
    <div ref={slotRef} className="h-[640px]">
      {Demo ? (
        <Demo />
      ) : (
        <div
          aria-hidden="true"
          className="h-full animate-pulse rounded-[22px] border border-white/10 bg-[#0e1524]/70"
        />
      )}
    </div>
  );
}
