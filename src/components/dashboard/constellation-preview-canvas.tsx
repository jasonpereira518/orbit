"use client";

import { useCallback, useLayoutEffect, useRef, useState } from "react";
import type { PreviewSky } from "@/lib/graph/preview-sky";
import {
  NEBULA_LOBE_EDGE,
  NEBULA_LOBE_MID,
  nebulaLobes,
} from "@/lib/graph/nebula-lobes";
import { withAlpha } from "@/lib/school-color";

/** Backing-store resolution cap: crisp dots on a retina card without a 4x store. */
const MAX_DPR = 1.5;
/** Screen px kept clear around the stars. */
const INSET = 18;
/** Never magnify a small network past this, or a handful of stars fills the card. */
const MAX_SCALE = 1.2;
/** How far from a cluster's centre still counts as pointing at it, in cluster radii. */
const HOVER_REACH = 1.15;

/** The card's world→screen transform, kept so the pointer can be tested against the sky. */
type Frame = { k: number; cx: number; cy: number; width: number; height: number };

/**
 * Paint the preview: one canvas, drawn once, and again only if its size changes.
 *
 * The same picture the chart draws — the clusters' washes, the constellation lines, the sun and
 * everyone's star — with none of its machinery: no React Flow, no per-star DOM, no animation
 * loop, and no contact records in the payload. Every wash is one gradient fill, dots are batched
 * into a path per colour and lines into a single path, so the whole sky is a few dozen fills
 * however many people are in it.
 */
function paint(canvas: HTMLCanvasElement, sky: PreviewSky): Frame | null {
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;
  if (width < 2 || height < 2) return null;
  const dpr = Math.min(window.devicePixelRatio || 1, MAX_DPR);
  const w = Math.round(width * dpr);
  const h = Math.round(height * dpr);
  if (canvas.width !== w) canvas.width = w;
  if (canvas.height !== h) canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;

  const { frame } = sky;
  const spanX = Math.max(frame.maxX - frame.minX, 1);
  const spanY = Math.max(frame.maxY - frame.minY, 1);
  const k = Math.min(MAX_SCALE, (width - INSET * 2) / spanX, (height - INSET * 2) / spanY);
  const cx = (frame.minX + frame.maxX) / 2;
  const cy = (frame.minY + frame.maxY) / 2;
  const sx = (x: number) => (x - cx) * k + width / 2;
  const sy = (y: number) => (y - cy) * k + height / 2;

  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);

  // The washes, behind everything: each cluster's colour, in the same five offset lobes the
  // chart draws in CSS (see nebula-lobes.ts), so the two skies are the same sky.
  for (const cluster of sky.clusters) {
    const color = sky.colors[cluster.c];
    if (!color) continue;
    for (const lobe of nebulaLobes(cluster.name, cluster.r)) {
      const rx = lobe.rx * k;
      const ry = lobe.ry * k;
      if (rx < 0.5 || ry < 0.5) continue;
      const x = sx(cluster.x + lobe.x);
      const y = sy(cluster.y + lobe.y);
      const fill = ctx.createRadialGradient(0, 0, 0, 0, 0, rx);
      fill.addColorStop(0, withAlpha(color, lobe.alpha));
      fill.addColorStop(NEBULA_LOBE_MID, withAlpha(color, lobe.alpha * 0.45));
      fill.addColorStop(NEBULA_LOBE_EDGE, withAlpha(color, 0));
      fill.addColorStop(1, withAlpha(color, 0));
      ctx.save();
      ctx.translate(x, y);
      ctx.scale(1, ry / rx);
      ctx.fillStyle = fill;
      ctx.beginPath();
      ctx.arc(0, 0, rx, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }
  }

  if (sky.lines.length > 0) {
    ctx.beginPath();
    for (let i = 0; i < sky.lines.length; i += 4) {
      ctx.moveTo(sx(sky.lines[i]), sy(sky.lines[i + 1]));
      ctx.lineTo(sx(sky.lines[i + 2]), sy(sky.lines[i + 3]));
    }
    ctx.strokeStyle = "rgba(255,255,255,0.16)";
    ctx.lineWidth = 1;
    ctx.stroke();
  }

  // The sun: you, at the centre of it all.
  const sunX = sx(0);
  const sunY = sy(0);
  const sun = ctx.createRadialGradient(sunX, sunY, 0, sunX, sunY, 16);
  sun.addColorStop(0, "rgba(255,246,214,1)");
  sun.addColorStop(0.3, "rgba(245,200,106,0.8)");
  sun.addColorStop(1, "rgba(255,160,60,0)");
  ctx.fillStyle = sun;
  ctx.fillRect(sunX - 16, sunY - 16, 32, 32);

  // Two passes per colour, each a single path: a faint halo, then the dot.
  for (const pass of ["halo", "dot"] as const) {
    for (let c = 0; c < sky.colors.length; c++) {
      ctx.beginPath();
      let any = false;
      for (let i = 0; i < sky.stars.length; i += 5) {
        if (sky.stars[i + 3] !== c) continue;
        const r = Math.min(3.2, Math.max(1.1, sky.stars[i + 2] * k * 2.2));
        const rr = pass === "halo" ? r * 2.6 : r;
        const x = sx(sky.stars[i]);
        const y = sy(sky.stars[i + 1]);
        ctx.moveTo(x + rr, y);
        ctx.arc(x, y, rr, 0, Math.PI * 2);
        any = true;
      }
      if (!any) continue;
      ctx.fillStyle = sky.colors[c];
      ctx.globalAlpha = pass === "halo" ? 0.12 : 0.9;
      ctx.fill();
    }
  }
  ctx.globalAlpha = 1;
  return { k, cx, cy, width, height };
}

type Hovered = { name: string; x: number; y: number };

export function ConstellationPreviewCanvas({ sky }: { sky: PreviewSky }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const frameRef = useRef<Frame | null>(null);
  const [hovered, setHovered] = useState<Hovered | null>(null);

  // Before paint, so the card never shows an empty frame; then only on a real size change.
  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    frameRef.current = paint(canvas, sky);
    let last = `${canvas.clientWidth}x${canvas.clientHeight}`;
    const observer = new ResizeObserver(() => {
      const size = `${canvas.clientWidth}x${canvas.clientHeight}`;
      if (size === last) return;
      last = size;
      frameRef.current = paint(canvas, sky);
      setHovered(null);
    });
    observer.observe(canvas);
    return () => observer.disconnect();
  }, [sky]);

  /**
   * The clusters are the only thing in the card you can point at, and pointing at one names it.
   * Tested against their centres rather than their washes, which overlap: the gap between two
   * clusters belongs to neither. The name is a plain element over the canvas, so hovering never
   * repaints the sky.
   */
  const onMove = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      const frame = frameRef.current;
      const canvas = canvasRef.current;
      if (!frame || !canvas) return;
      const rect = canvas.getBoundingClientRect();
      const px = event.clientX - rect.left;
      const py = event.clientY - rect.top;
      const wx = (px - frame.width / 2) / frame.k + frame.cx;
      const wy = (py - frame.height / 2) / frame.k + frame.cy;
      let best: Hovered | null = null;
      let bestD = Infinity;
      for (const cluster of sky.clusters) {
        const reach = cluster.r * HOVER_REACH;
        const d = (wx - cluster.x) ** 2 + (wy - cluster.y) ** 2;
        if (d > reach * reach || d >= bestD) continue;
        bestD = d;
        best = {
          name: cluster.name,
          x: (cluster.x - frame.cx) * frame.k + frame.width / 2,
          y: (cluster.y - frame.cy) * frame.k + frame.height / 2 - cluster.r * frame.k - 8,
        };
      }
      setHovered((prev) =>
        prev?.name === best?.name && prev?.x === best?.x && prev?.y === best?.y ? prev : best
      );
    },
    [sky.clusters]
  );

  return (
    <div
      className="relative h-full w-full"
      onMouseMove={onMove}
      onMouseLeave={() => setHovered(null)}
    >
      <canvas ref={canvasRef} aria-hidden className="block h-full w-full" />
      {hovered && (
        <span
          className="pointer-events-none absolute -translate-x-1/2 -translate-y-full whitespace-nowrap text-[11px] font-semibold tracking-[0.08em] text-white [text-shadow:0_1px_6px_rgba(0,0,0,0.9)]"
          style={{ left: hovered.x, top: Math.max(12, hovered.y) }}
        >
          {hovered.name}
        </span>
      )}
    </div>
  );
}
