"use client";

import { useEffect, useRef } from "react";
import {
  BEAT,
  EARTH_SRC,
  easeIn,
  easeOut,
  pingTargets,
  ringLayout,
  ringSpin,
  seg,
  type SceneNode,
} from "@/lib/radar/activation-scene";

/** Deep space, the same navy as the credits intro and Constellation, in both themes. */
export const FIELD = "#0B1220";
const GOLD = "196,163,90";
const TEAL = "93,202,165";
const TAU = Math.PI * 2;

/* ------------------------------------------------------------------ images ----- */

type Loaded = { img: HTMLImageElement; ok: boolean };
/** Shared by the hero and the stage, so the faces you saw are already loaded when it plays. */
const images = new Map<string, Loaded>();

/** Starts loading every image the scene needs; `onLoad` fires as each one arrives. */
export function preloadImages(nodes: readonly SceneNode[], onLoad: () => void): void {
  const want = [EARTH_SRC, ...nodes.flatMap((n) => [n.src, n.planet])];
  for (const src of new Set(want)) {
    const known = images.get(src);
    if (known) {
      if (known.ok) onLoad();
      else known.img.addEventListener("load", onLoad, { once: true });
      continue;
    }
    const img = new Image();
    img.decoding = "async";
    const entry: Loaded = { img, ok: false };
    images.set(src, entry);
    img.addEventListener("load", () => {
      entry.ok = true;
      onLoad();
    }, { once: true });
    img.src = src;
  }
}

/** The photo if it loaded, else the planet, else nothing (a plain disc). */
function imageFor(node: SceneNode): HTMLImageElement | null {
  const photo = images.get(node.src);
  if (photo?.ok) return photo.img;
  const planet = images.get(node.planet);
  return planet?.ok ? planet.img : null;
}

/* ------------------------------------------------------------------ drawing ----- */

function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Particles that stream into you during the charge. Fixed, so every play is the same. */
const MOTES = (() => {
  const r = rng(11);
  return Array.from({ length: 110 }, () => ({ a: r() * TAU, d: 0.9 + r() * 0.5, delay: r() * 0.45, size: 0.8 + r() * 1.4 }));
})();
const SKY = (() => {
  const r = rng(7);
  return Array.from({ length: 120 }, () => ({ x: r(), y: r(), a: 0.06 + r() * 0.2, s: 0.4 + r() * 0.8 }));
})();

function disc(ctx: CanvasRenderingContext2D, img: HTMLImageElement | null, x: number, y: number, r: number) {
  ctx.save();
  ctx.beginPath();
  ctx.arc(x, y, r, 0, TAU);
  ctx.clip();
  if (img) {
    // Cover-fit a square crop of the image into the disc.
    const s = Math.min(img.naturalWidth, img.naturalHeight) || 1;
    ctx.drawImage(img, (img.naturalWidth - s) / 2, (img.naturalHeight - s) / 2, s, s, x - r, y - r, r * 2, r * 2);
  } else {
    ctx.fillStyle = "#2a3550";
    ctx.fillRect(x - r, y - r, r * 2, r * 2);
  }
  ctx.restore();
}

export type SceneView = {
  /** Scene time in ms; below 0 is the dormant hero. */
  t: number;
  w: number;
  h: number;
  nodes: readonly SceneNode[];
  /** Beat 1: where the hero sat, so the stage grows out of it. */
  from?: { cx: number; cy: number; scale: number } | null;
  /** Beat 6: offset from the centre to the nav's Radar icon, and the scale that fits it. */
  to?: { dx: number; dy: number; scale: number } | null;
};

/**
 * One frame. Everything derives from `t`, so a skip is just a jump in time and the
 * dormant hero is the same picture at t < 0.
 */
export function drawScene(ctx: CanvasRenderingContext2D, v: SceneView) {
  const { t, w, h, nodes } = v;
  const dormant = t < 0;
  // Beat 6: the night sky fades out while the network flies home, so the page (and the
  // nav's Radar icon it lands in) shows through instead of staying hidden under navy.
  const sky = 1 - seg(t, BEAT.land, BEAT.land + (BEAT.end - BEAT.land) * 0.6);
  ctx.clearRect(0, 0, w, h);
  ctx.globalAlpha = sky;
  ctx.fillStyle = FIELD;
  ctx.fillRect(0, 0, w, h);
  for (const s of SKY) {
    ctx.fillStyle = `rgba(255,255,255,${s.a})`;
    ctx.beginPath();
    ctx.arc(s.x * w, s.y * h, s.s, 0, TAU);
    ctx.fill();
  }
  ctx.globalAlpha = 1;

  const layout = ringLayout(w, h);
  const outer = layout.radii[2];
  let cx = w / 2;
  let cy = h / 2;
  let scale = 1;
  // Beat 1: grow out of the hero's position.
  if (v.from && t < BEAT.charge) {
    const k = easeOut(seg(t, BEAT.press, BEAT.charge));
    cx = v.from.cx + (cx - v.from.cx) * k;
    cy = v.from.cy + (cy - v.from.cy) * k;
    scale = v.from.scale + (1 - v.from.scale) * k;
  }
  // Beat 6: shrink into the nav's Radar icon.
  // Arrives 200ms early, so it visibly settles on the icon before the last fade.
  const land = easeOut(seg(t, BEAT.land, BEAT.end - 200));
  if (land > 0 && v.to) {
    cx += v.to.dx * land;
    cy += v.to.dy * land;
  }
  // Shrinks until the outer ring is the icon's size (6% when there is no icon to land in).
  scale *= 1 - (1 - (v.to?.scale ?? 0.06)) * land;

  ctx.save();
  ctx.translate(cx, cy);
  ctx.scale(scale, scale);

  const charge = seg(t, BEAT.charge, BEAT.ignite);
  const ignite = seg(t, BEAT.ignite, BEAT.spin);
  const sweep = seg(t, BEAT.sweep, BEAT.land);
  const wave = t >= BEAT.ignite ? easeOut(ignite) * (outer + 60) : -1;

  // Beat 2: motes stream in from beyond the rings, accelerating.
  if (t >= BEAT.charge && t < BEAT.ignite + 100) {
    const reach = Math.hypot(w, h) * 0.6;
    for (const m of MOTES) {
      const k = easeIn(seg(charge, m.delay, m.delay + 0.55));
      if (k <= 0 || k >= 1) continue;
      const r = reach * m.d * (1 - k);
      ctx.fillStyle = `rgba(${GOLD},${0.25 + 0.65 * k})`;
      ctx.beginPath();
      ctx.arc(Math.cos(m.a) * r, Math.sin(m.a) * r, m.size + 1.2 * k, 0, TAU);
      ctx.fill();
    }
  }

  // Dormant: one still, unlit radar ring.
  if (dormant) {
    ctx.strokeStyle = "rgba(160,172,196,0.22)";
    ctx.setLineDash([4, 7]);
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(0, 0, outer + 28, 0, TAU);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  // Beat 3: the shockwave.
  if (ignite > 0 && ignite < 1) {
    ctx.strokeStyle = `rgba(${GOLD},${0.9 * (1 - ignite)})`;
    ctx.lineWidth = 3 + 3 * (1 - ignite);
    ctx.beginPath();
    ctx.arc(0, 0, wave, 0, TAU);
    ctx.stroke();
  }

  // Beat 5: the beam, one full turn.
  const beamTurned = easeOut(sweep) * TAU;
  if (sweep > 0 && sweep < 1 && typeof ctx.createConicGradient === "function") {
    const a = -Math.PI / 2 + beamTurned;
    const g = ctx.createConicGradient(a - 1.0, 0, 0);
    g.addColorStop(0, `rgba(${TEAL},0)`);
    g.addColorStop(0.155, `rgba(${TEAL},0.2)`);
    g.addColorStop(0.159, `rgba(${GOLD},0.75)`);
    g.addColorStop(0.164, `rgba(${TEAL},0)`);
    g.addColorStop(1, `rgba(${TEAL},0)`);
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(0, 0, outer + 70, 0, TAU);
    ctx.fill();
  }

  // The people. No lines between them: each is its own lit body.
  const pings = new Set(pingTargets(nodes));
  const flicker = t >= BEAT.charge && t < BEAT.ignite;
  nodes.forEach((n, i) => {
    const r0 = layout.radii[n.ring];
    const angle = n.angle + ringSpin(t, n.ring);
    const x = Math.cos(angle) * r0;
    const y = Math.sin(angle) * r0;
    const lit = dormant ? 0 : t >= BEAT.spin ? 1 : wave < 0 ? 0 : Math.max(0, Math.min(1, (wave - r0) / 40));
    const pop = lit > 0 && lit < 1 ? 1 + 0.4 * Math.sin(lit * Math.PI) : 1;
    const nr = layout.nodeRadius[n.ring] * pop;

    // Beat 4 on: a thin gold halo per person.
    const halo = seg(t, BEAT.spin, BEAT.spin + 400);
    if (halo > 0) {
      ctx.strokeStyle = `rgba(${GOLD},${0.55 * halo})`;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(x, y, nr + 3, 0, TAU);
      ctx.stroke();
    }

    ctx.filter = lit < 1 ? `grayscale(${1 - lit})` : "none";
    disc(ctx, imageFor(n), x, y, nr);
    ctx.filter = "none";
    // Dim until lit. Also stands in for grayscale where canvas filters are unsupported.
    const dim = (1 - lit) * (flicker ? 0.5 + 0.08 * Math.sin(t / 45 + i) : 0.55);
    if (dim > 0) {
      ctx.fillStyle = `rgba(11,18,32,${dim})`;
      ctx.beginPath();
      ctx.arc(x, y, nr, 0, TAU);
      ctx.fill();
    }

    // Beat 5: pinged once the beam passes. No labels: the first plan hasn't run yet.
    if (pings.has(i) && sweep > 0) {
      const rel = (((angle + Math.PI / 2) % TAU) + TAU) % TAU;
      const since = (beamTurned - rel) / 1.2;
      if (since > 0) {
        const p = Math.min(1, since);
        const fade = 1 - seg(t, BEAT.land, BEAT.land + 300);
        ctx.strokeStyle = `rgba(${GOLD},${(1 - 0.7 * p) * fade})`;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(x, y, nr + 6 + p * 16, 0, TAU);
        ctx.stroke();
      }
    }
  });

  // You, at the centre: Earth, charging up.
  const core = dormant ? 0 : t < BEAT.ignite ? easeIn(charge) : 1 - 0.4 * seg(t, BEAT.ignite, BEAT.sweep);
  const er = layout.earthRadius * (1 + 0.18 * core);
  if (core > 0) {
    const g = ctx.createRadialGradient(0, 0, er * 0.8, 0, 0, er * (2.2 + core));
    g.addColorStop(0, `rgba(${t < BEAT.ignite ? TEAL : GOLD},${0.55 * core})`);
    g.addColorStop(1, `rgba(${GOLD},0)`);
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(0, 0, er * (2.2 + core), 0, TAU);
    ctx.fill();
  }
  // Two ripples during the charge, the second faster.
  if (t >= BEAT.charge && t < BEAT.ignite) {
    for (const [a, b] of [
      [0, 0.5],
      [0.55, 0.85],
    ] as const) {
      const k = seg(charge, a, b);
      if (k <= 0 || k >= 1) continue;
      ctx.strokeStyle = `rgba(${TEAL},${0.5 * (1 - k)})`;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(0, 0, er + k * 90, 0, TAU);
      ctx.stroke();
    }
  }
  const earth = images.get(EARTH_SRC);
  ctx.filter = dormant ? "grayscale(0.6) brightness(0.7)" : "none";
  disc(ctx, earth?.ok ? earth.img : null, 0, 0, er);
  ctx.filter = "none";
  // Ignition: a single glow over you, opacity only (never a full-screen flash).
  const flash = t >= BEAT.ignite ? 1 - seg(t, BEAT.ignite, BEAT.ignite + 260) : 0;
  if (flash > 0) {
    ctx.fillStyle = `rgba(255,248,230,${0.85 * flash})`;
    ctx.beginPath();
    ctx.arc(0, 0, er * (1 + 0.6 * (1 - flash)), 0, TAU);
    ctx.fill();
  }

  ctx.restore();
}

/** Size a canvas's backing store to a CSS box at device pixel ratio. */
export function fitCanvas(canvas: HTMLCanvasElement, ctx: CanvasRenderingContext2D, w: number, h: number) {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}

/**
 * Beat 0, in the page: the same rings, dim and still. Redrawn only when an image arrives or
 * the box resizes, never on a loop.
 */
export function ActivationHeroCanvas({ nodes, hidden }: { nodes: readonly SceneNode[]; hidden: boolean }) {
  const ref = useRef<HTMLCanvasElement | null>(null);
  useEffect(() => {
    const canvas = ref.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    let size = { w: 0, h: 0 };
    const draw = () => {
      if (size.w > 0) drawScene(ctx, { t: -1, w: size.w, h: size.h, nodes });
    };
    const ro = new ResizeObserver(([entry]) => {
      size = { w: entry.contentRect.width, h: entry.contentRect.height };
      fitCanvas(canvas, ctx, size.w, size.h);
      draw();
    });
    ro.observe(canvas);
    preloadImages(nodes, draw);
    return () => ro.disconnect();
  }, [nodes]);
  return (
    <canvas
      ref={ref}
      aria-hidden
      data-radar-hero
      className="block h-full w-full"
      style={{ visibility: hidden ? "hidden" : "visible" }}
    />
  );
}
