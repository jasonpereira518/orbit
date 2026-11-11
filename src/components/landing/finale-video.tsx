"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { usePrefersReducedMotion } from "@/lib/use-prefers-reduced-motion";
import { cn } from "@/lib/utils";

const CLIP = "/landing/video/earth-night-v1";

/**
 * The finale's backdrop: the North American east coast at night from the space station, on
 * a nine-second loop. Decorative, silent, and never the only thing carrying the section.
 *
 * It plays only while on screen, and not at all under reduced motion, where the poster
 * stands in. The pause control is always there: moving content that starts on its own and
 * runs longer than five seconds needs one (WCAG 2.2.2).
 */
export function FinaleVideo({ className, children }: { className?: string; children?: ReactNode }) {
  const ref = useRef<HTMLVideoElement>(null);
  const reduced = usePrefersReducedMotion();
  const [paused, setPaused] = useState(false);
  const still = reduced || paused;

  useEffect(() => {
    const video = ref.current;
    if (!video) return;
    if (still) {
      video.pause();
      return;
    }
    const io = new IntersectionObserver(
      ([entry]) => {
        // play() rejects if the element is paused again before it starts; nothing to do.
        if (entry?.isIntersecting) void video.play().catch(() => {});
        else video.pause();
      },
      { rootMargin: "200px" },
    );
    io.observe(video);
    return () => io.disconnect();
  }, [still]);

  return (
    <>
      {/* `className` (the edge mask) goes on the box, so anything laid over the video
        * (`children`) is masked with it. The pause button below stays outside. */}
      <div className={cn("absolute inset-0", className)}>
        <video
          ref={ref}
          aria-hidden
          tabIndex={-1}
          muted
          loop
          playsInline
          preload="none"
          poster={`${CLIP}.webp`}
          className="absolute inset-0 size-full object-cover"
        >
          <source src={`${CLIP}.webm`} type="video/webm" />
          <source src={`${CLIP}.mp4`} type="video/mp4" />
        </video>
        {children}
      </div>
      {!reduced && (
        <button
          type="button"
          onClick={() => setPaused((value) => !value)}
          aria-pressed={paused}
          className="absolute bottom-[18%] right-4 z-10 inline-flex min-h-11 items-center rounded-full bg-[#03050c]/70 px-4 text-sm text-[#e8f3f1] transition-colors hover:bg-[#03050c]/90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#f2c14e] md:right-6"
        >
          {paused ? "Play background video" : "Pause background video"}
        </button>
      )}
    </>
  );
}
