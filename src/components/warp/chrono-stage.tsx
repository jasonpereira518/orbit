"use client";

import { useEffect, useRef } from "react";
import { CHRONO_IN, CHRONO_OUT } from "@/lib/warp/chrono";
import { span } from "@/lib/warp/choreography";
import { DEEP_SPACE, paintSpace } from "@/lib/sky-palette";
import type { WarpRun } from "@/components/warp/warp-provider";

/**
 * The time warp, painted.
 *
 * One canvas, one rAF loop, every beat derived from elapsed time rather than
 * from React state — the provider re-renders at most five times per run, which
 * is nowhere near enough to drive an animation. `run` is read through a ref so
 * a phase change never restarts the loop mid-flight.
 *
 * This file owns two layers: the deep-space base, painted once per resize and
 * blitted (it is the exact image the real starfield paints, which is what makes
 * the handoff at the end invisible), and the trail layer above it.
 */
export function ChronoStage({ run }: { run: WarpRun }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const runRef = useRef(run);
  // Synced after commit rather than during render; the loop picks the new
  // value up on its next frame, which is 16ms it will never notice.
  useEffect(() => {
    runRef.current = run;
  }, [run]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    let raf = 0;
    let width = 0;
    let height = 0;
    let dpr = 1;
    let space: HTMLCanvasElement | null = null;

    function paintSpaceLayer() {
      const off = document.createElement("canvas");
      off.width = Math.floor(width * dpr);
      off.height = Math.floor(height * dpr);
      const bctx = off.getContext("2d");
      if (!bctx) return;
      bctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      paintSpace(bctx, width, height);
      space = off;
    }

    function resize() {
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      width = window.innerWidth;
      height = window.innerHeight;
      canvas!.width = Math.floor(width * dpr);
      canvas!.height = Math.floor(height * dpr);
      canvas!.style.width = `${width}px`;
      canvas!.style.height = `${height}px`;
      ctx!.setTransform(dpr, 0, 0, dpr, 0, 0);
      paintSpaceLayer();
    }

    /**
     * How much of the frame the stage covers, 0 to 1.
     *
     * Opening: the shutter window, which is also when the route swap hides
     * behind it. Closing: the arriving window, cross-fading into the real
     * starfield underneath, and the landing window on the way home, where the
     * room lights come back up.
     */
    function coverage(now: number) {
      const r = runRef.current;
      if (r.reduced) return 1;
      const elapsed = now - r.startedAt;
      if (r.phase === "arriving") {
        const since = r.arrivingAt === null ? 0 : now - r.arrivingAt;
        // Hold through the collapse, then hand off.
        return 1 - span(since, [380, 620]);
      }
      if (r.phase === "inbound" || r.phase === "landing") {
        const [from, to] = CHRONO_IN.landing;
        return 1 - span(elapsed, [from, to]);
      }
      return span(elapsed, CHRONO_OUT.shutter);
    }

    function frame() {
      const now = performance.now();
      ctx!.clearRect(0, 0, width, height);
      ctx!.fillStyle = DEEP_SPACE;
      ctx!.fillRect(0, 0, width, height);
      if (space) ctx!.drawImage(space, 0, 0, width, height);

      canvas!.style.opacity = String(coverage(now));
      raf = requestAnimationFrame(frame);
    }

    resize();
    window.addEventListener("resize", resize);
    raf = requestAnimationFrame(frame);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", resize);
    };
  }, []);

  return (
    <canvas
      ref={canvasRef}
      aria-hidden="true"
      className="pointer-events-none fixed inset-0 z-[100] h-full w-full"
      style={{ opacity: 0 }}
    />
  );
}
