"use client";

import { useEffect, useRef, useState } from "react";
import { LAST_TALKED_STOPS } from "@/components/landing/hero-choreography";

/**
 * The landing hero's 3D scene on its own, full frame, with no page around it. Exists only in
 * ORBIT_BENCH=1 builds. Two uses: tuning the scene without scrolling the landing page, and
 * `scripts/dev/capture-landing.mjs`, which screenshots it for the hero's posters.
 *
 * Query: `p` (scroll progress 0–1), `days` (the slider's person), `t` (freeze the orbits at
 * this many seconds, for a repeatable frame), `light=1` (the phone tier), `layout=still` (the
 * tight overhead framing of the static page's picture), `bare=1` (no controls). `<html data-hero-ready>` is set once the first full frame is drawn.
 */
export default function HeroBench() {
  const hostRef = useRef<HTMLDivElement>(null);
  const progress = useRef(0);
  const days = useRef(14);
  const [bare, setBare] = useState(true);
  const [shown, setShown] = useState({ p: 0, stop: 3 });

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const query = new URLSearchParams(window.location.search);
    progress.current = Number(query.get("p") ?? 0);
    days.current = Number(query.get("days") ?? 14);
    setBare(query.get("bare") === "1");
    setShown((s) => ({ ...s, p: progress.current }));
    const fixedTime = query.has("t") ? Number(query.get("t")) : undefined;

    let dispose = () => {};
    let cancelled = false;
    void import("@/components/landing/hero-scene").then(({ mountHeroScene }) => {
      if (cancelled) return;
      dispose = mountHeroScene(host, {
        progress: () => progress.current,
        liveDays: () => days.current,
        anchors: { rings: [], live: null },
        light: query.get("light") === "1",
        fixedTime,
        layout: query.get("layout") === "still" ? "still" : undefined,
        onReady: () => {
          document.documentElement.dataset.heroReady = "1";
        },
        onLost: () => {},
      });
    });
    return () => {
      cancelled = true;
      dispose();
    };
  }, []);

  return (
    <div className="fixed inset-0 bg-[#03050c]">
      <div ref={hostRef} className="absolute inset-0" />
      {!bare && (
        <div className="absolute inset-x-4 bottom-4 flex flex-col gap-2 rounded-lg bg-black/60 p-3 text-sm text-white">
          <label className="flex items-center gap-3">
            <span className="w-28">scroll {shown.p.toFixed(2)}</span>
            <input
              type="range"
              min={0}
              max={1}
              step={0.005}
              value={shown.p}
              className="flex-1"
              onChange={(e) => {
                progress.current = Number(e.target.value);
                setShown((s) => ({ ...s, p: progress.current }));
              }}
            />
          </label>
          <label className="flex items-center gap-3">
            <span className="w-28">{LAST_TALKED_STOPS[shown.stop].label}</span>
            <input
              type="range"
              min={0}
              max={LAST_TALKED_STOPS.length - 1}
              step={1}
              value={shown.stop}
              className="flex-1"
              onChange={(e) => {
                const stop = Number(e.target.value);
                days.current = LAST_TALKED_STOPS[stop].days;
                setShown((s) => ({ ...s, stop }));
              }}
            />
          </label>
        </div>
      )}
    </div>
  );
}
