"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { LocateFixed } from "lucide-react";
import { expandPreviewSky, type PreviewSky } from "@/lib/graph/preview-sky-shape";
import { buildSkyIndex, type SkyIndex } from "@/components/graph/sky-canvas/sky-index";
import { drawSky } from "@/components/graph/sky-canvas/draw-sky";
import { bakeBackground } from "@/components/graph/sky-canvas/sky-sprites";
import { useSkyGestures } from "@/components/graph/sky-canvas/use-sky-gestures";
import {
  NEBULA_LOBE_EDGE,
  NEBULA_LOBE_MID,
  nebulaLobes,
} from "@/lib/graph/nebula-lobes";
import { clampPan, fitStarsToPane, zoomAt, type Camera } from "@/lib/graph/sky-camera";
import type { SkyFocusState } from "@/lib/graph/sky-emphasis";
import { withAlpha } from "@/lib/school-color";
import { usePrefersReducedMotion } from "@/lib/use-prefers-reduced-motion";
import { cn } from "@/lib/utils";

/** Backing-store resolution cap: crisp stars on a retina card without a 4x store. */
const MAX_DPR = 1.5;
/** Screen px kept clear around the stars. */
const INSET = { x: 22, top: 18, bottom: 18 };
/** The washes' bitmap is at most this many px on its long side, and never finer than world px. */
const WASH_MAX_PX = 2048;
/**
 * Zoom per px of ctrl+wheel travel. A trackpad pinch arrives as ctrl+wheel in steps of a few px;
 * a mouse wheel notch is ~100px, which this makes a ~1.2x step.
 */
const WHEEL_ZOOM_RATE = 0.002;

/** Nothing is hovered, selected or searched in the card. */
const RESTING: SkyFocusState = {
  hoveredId: null,
  selectedContactId: null,
  searchHitIds: new Set(),
  searchDimActive: false,
};

type WashBitmap = { canvas: HTMLCanvasElement; minX: number; minY: number; scale: number };

/**
 * The clusters' washes, as the desktop chart paints them, baked once into a world-space bitmap.
 *
 * `drawSky` has washes of its own, but they are the phone's: one blurred sprite per cluster,
 * brighter and rounder than the five soft lobes a laptop shows (`NebulaWashNode` in
 * graph-nodes.tsx). The card sits on the laptop's dashboard, so it takes the laptop's clouds —
 * and bakes them, so a pan frame is one blit rather than five gradients per cluster. The clouds
 * are soft by design, so a bitmap coarser than the screen when zoomed in loses nothing.
 */
function bakeWashes(index: SkyIndex): WashBitmap | null {
  const lobes = index.nebulae.flatMap((n) =>
    nebulaLobes(n.company, n.radius).map((lobe) => ({
      ...lobe,
      cx: n.x + lobe.x,
      cy: n.y + lobe.y,
      color: n.color,
    }))
  );
  if (lobes.length === 0) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const l of lobes) {
    minX = Math.min(minX, l.cx - l.rx);
    minY = Math.min(minY, l.cy - l.ry);
    maxX = Math.max(maxX, l.cx + l.rx);
    maxY = Math.max(maxY, l.cy + l.ry);
  }
  const scale = Math.min(1, WASH_MAX_PX / Math.max(maxX - minX, maxY - minY, 1));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.ceil((maxX - minX) * scale));
  canvas.height = Math.max(1, Math.ceil((maxY - minY) * scale));
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  ctx.setTransform(scale, 0, 0, scale, -minX * scale, -minY * scale);

  for (const l of lobes) {
    // A zero-radius gradient throws; under half a pixel there is nothing to draw anyway.
    if (l.rx * scale < 0.5 || l.ry * scale < 0.5) continue;
    const fill = ctx.createRadialGradient(0, 0, 0, 0, 0, l.rx);
    fill.addColorStop(0, withAlpha(l.color, l.alpha));
    fill.addColorStop(NEBULA_LOBE_MID, withAlpha(l.color, l.alpha * 0.45));
    fill.addColorStop(NEBULA_LOBE_EDGE, withAlpha(l.color, 0));
    fill.addColorStop(1, withAlpha(l.color, 0));
    ctx.save();
    ctx.translate(l.cx, l.cy);
    ctx.scale(1, l.ry / l.rx);
    ctx.fillStyle = fill;
    ctx.beginPath();
    ctx.arc(0, 0, l.rx, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }
  return { canvas, minX, minY, scale };
}

/**
 * The constellation tab's sky, in a card you can move around.
 *
 * Drawn by the chart's own canvas renderer — the same star sprites, starfield and constellation
 * lines, over the desktop chart's washes — and moved by the phone chart's own gestures: drag to
 * pan, pinch (or ctrl/⌘+scroll, which is what a trackpad pinch sends) to zoom. A tap opens the
 * full chart. What it leaves out is everything else that makes the tab a tool: no React Flow, no
 * per-star DOM, no names, no selection. Between gestures it draws nothing at all.
 *
 * On a phone the card sits in a scrolling page, so a vertical swipe stays the page's (see
 * `touch-pan-y` below): one finger moves the sky sideways, two fingers move it anywhere.
 */
export function ConstellationPreviewCanvas({
  sky,
  href,
  label,
}: {
  sky: PreviewSky;
  /** Where a tap goes. */
  href: string;
  label: string;
}) {
  const router = useRouter();
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const ctxRef = useRef<CanvasRenderingContext2D | null>(null);
  const paneRef = useRef({ width: 0, height: 0, dpr: 1 });
  const cameraRef = useRef<Camera>({ x: 0, y: 0, k: 1 });
  const homeRef = useRef<Camera>({ x: 0, y: 0, k: 1 });
  const backgroundRef = useRef<HTMLCanvasElement | null>(null);
  const backdropRef = useRef<HTMLCanvasElement | null>(null);
  const rafRef = useRef(0);
  const movedRef = useRef(false);
  const [moved, setMoved] = useState(false);
  const prefersReducedMotion = usePrefersReducedMotion();

  const layout = useMemo(() => expandPreviewSky(sky), [sky]);
  const index = useMemo(() => buildSkyIndex(layout), [layout]);
  // What `drawSky` paints itself: the washes come from `bakeWashes`, under it.
  const drawn = useMemo<SkyIndex>(() => ({ ...index, nebulae: [] }), [index]);
  const washesRef = useRef<WashBitmap | null>(null);

  const draw = useCallback(() => {
    rafRef.current = 0;
    const ctx = ctxRef.current;
    const backdrop = backdropRef.current;
    const { width, height, dpr } = paneRef.current;
    if (!ctx || !backdrop || width < 2 || height < 2) return;
    const camera = cameraRef.current;

    // The screen-space starfield, then the world-space washes at the camera — composited into
    // one bitmap, because `drawSky` clears the canvas and then paints its background first.
    const bctx = backdrop.getContext("2d");
    if (!bctx) return;
    bctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    bctx.clearRect(0, 0, width, height);
    if (backgroundRef.current) bctx.drawImage(backgroundRef.current, 0, 0, width, height);
    const washes = washesRef.current;
    if (washes) {
      bctx.drawImage(
        washes.canvas,
        washes.minX * camera.k + camera.x,
        washes.minY * camera.k + camera.y,
        (washes.canvas.width / washes.scale) * camera.k,
        (washes.canvas.height / washes.scale) * camera.k
      );
    }

    drawSky(ctx, {
      index: drawn,
      camera,
      width,
      height,
      focus: RESTING,
      focusCluster: null,
      focusCompany: null,
      companyFilter: "all",
      sunSelected: false,
      background: backdrop,
    });
  }, [drawn]);

  /** At most one frame per display refresh, and none at all while nothing moves. */
  const requestDraw = useCallback(() => {
    if (!rafRef.current) rafRef.current = requestAnimationFrame(draw);
  }, [draw]);

  // Clear the handle as well as cancelling it: `requestDraw` gates on it, so a stale one left by
  // StrictMode's unmount/remount would wedge the card, taking gestures and painting nothing.
  useEffect(
    () => () => {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = 0;
    },
    []
  );

  // Before paint, so the card never shows an empty frame.
  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    washesRef.current = bakeWashes(index);
    let last = "";

    const resize = () => {
      const width = canvas.clientWidth;
      const height = canvas.clientHeight;
      const size = `${width}x${height}`;
      if (width < 2 || height < 2 || size === last) return;
      const previous = paneRef.current;
      last = size;

      const dpr = Math.min(window.devicePixelRatio || 1, MAX_DPR);
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctxRef.current = ctx;
      paneRef.current = { width, height, dpr };

      const backdrop = backdropRef.current ?? document.createElement("canvas");
      backdrop.width = canvas.width;
      backdrop.height = canvas.height;
      backdropRef.current = backdrop;
      backgroundRef.current = bakeBackground(width, height, dpr);

      homeRef.current = fitStarsToPane(layout.nodes, { width, height }, INSET);
      if (!movedRef.current || previous.width < 2) {
        cameraRef.current = homeRef.current;
      } else {
        // Keep the world point that was centred, centred.
        cameraRef.current = {
          ...cameraRef.current,
          x: cameraRef.current.x + (width - previous.width) / 2,
          y: cameraRef.current.y + (height - previous.height) / 2,
        };
      }
      cancelAnimationFrame(rafRef.current);
      draw();
    };

    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(canvas);
    return () => observer.disconnect();
  }, [index, layout.nodes, draw]);

  const onCameraChanged = useCallback(() => {
    if (!movedRef.current) {
      movedRef.current = true;
      setMoved(true);
    }
    requestDraw();
  }, [requestDraw]);

  const gestureHandlers = useMemo(
    () => ({
      cameraRef,
      bounds: () => index.bounds,
      pane: () => paneRef.current,
      onCameraChanged,
      onTap: () => router.push(href),
      onSettled: () => {},
      reducedMotion: prefersReducedMotion,
      movable: true,
      cancelTween: () => {},
    }),
    [index, onCameraChanged, router, href, prefersReducedMotion]
  );
  useSkyGestures(containerRef, gestureHandlers);

  /**
   * Zoom on a trackpad pinch or ctrl/⌘+scroll, about the pointer. A plain scroll is left alone:
   * it belongs to the page, and a card that swallowed it would trap the dashboard. Non-passive,
   * so the browser's own page zoom does not fire as well.
   */
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      const anchor = { x: e.clientX - rect.left, y: e.clientY - rect.top };
      const zoomed = zoomAt(cameraRef.current, anchor, Math.exp(-e.deltaY * WHEEL_ZOOM_RATE));
      cameraRef.current = clampPan(zoomed, index.bounds, paneRef.current);
      onCameraChanged();
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [index, onCameraChanged]);

  const recenter = () => {
    cameraRef.current = homeRef.current;
    movedRef.current = false;
    setMoved(false);
    requestDraw();
  };

  return (
    <div className="relative h-full w-full">
      <div
        ref={containerRef}
        role="img"
        aria-label={label}
        className="h-full w-full cursor-grab touch-pan-y select-none overscroll-none active:cursor-grabbing [-webkit-tap-highlight-color:transparent] [-webkit-touch-callout:none]"
      >
        <canvas ref={canvasRef} aria-hidden className="block h-full w-full" />
      </div>
      {moved && (
        <button
          type="button"
          onClick={recenter}
          aria-label="Recenter the constellation"
          title="Recenter"
          className={cn(
            "absolute right-2.5 top-2.5 flex size-8 items-center justify-center rounded-full",
            "border border-white/15 bg-black/55 text-white/80 transition-colors",
            "hover:bg-black/60 hover:text-white focus-visible:outline-2 focus-visible:outline-white/70"
          )}
        >
          <LocateFixed className="size-4" aria-hidden />
        </button>
      )}
    </div>
  );
}
