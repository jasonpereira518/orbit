"use client";

import { useLayoutEffect, useRef } from "react";
import type { PreviewSky } from "@/lib/graph/preview-sky";

/** Backing-store resolution cap: crisp dots on a retina card without a 4x store. */
const MAX_DPR = 1.5;
/** Screen px kept clear around the stars. */
const INSET = 18;
/** Never magnify a small network past this, or a handful of stars fills the card. */
const MAX_SCALE = 1.2;

/**
 * Paint the preview: one canvas, drawn once, and again only if its size changes.
 *
 * No names, no hover, no animation loop and no React Flow — the card is a glance and a link.
 * Dots are batched into one path per colour, lines into one path, so the whole sky is a handful
 * of fills however many people are in it.
 */
function paint(canvas: HTMLCanvasElement, sky: PreviewSky) {
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;
  if (width < 2 || height < 2) return;
  const dpr = Math.min(window.devicePixelRatio || 1, MAX_DPR);
  const w = Math.round(width * dpr);
  const h = Math.round(height * dpr);
  if (canvas.width !== w) canvas.width = w;
  if (canvas.height !== h) canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;

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
}

export function ConstellationPreviewCanvas({ sky }: { sky: PreviewSky }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  // Before paint, so the card never shows an empty frame; then only on a real size change.
  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    paint(canvas, sky);
    let last = `${canvas.clientWidth}x${canvas.clientHeight}`;
    const observer = new ResizeObserver(() => {
      const size = `${canvas.clientWidth}x${canvas.clientHeight}`;
      if (size === last) return;
      last = size;
      paint(canvas, sky);
    });
    observer.observe(canvas);
    return () => observer.disconnect();
  }, [sky]);

  return <canvas ref={canvasRef} aria-hidden className="block h-full w-full" />;
}
