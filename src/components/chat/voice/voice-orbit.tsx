"use client";

import { useEffect, useRef, type RefObject } from "react";
import type { VoiceAgentControls, VoiceMode } from "@/lib/voice/contracts";
import { usePrefersReducedMotion } from "@/lib/use-prefers-reduced-motion";
import { easeOrbWeights, orbParams, orbWeights, smoothVoiceLevel, type OrbParams } from "@/lib/voice/visual-level";

type Rgb = readonly [number, number, number];
const BODY = "#160c3a";
const VIOLET: Rgb = [167, 139, 250];
const CYAN: Rgb = [34, 211, 238];
const PINK: Rgb = [244, 114, 182];
const TAU = Math.PI * 2;
const rgba = (c: Rgb, a: number) => `rgba(${c[0]},${c[1]},${c[2]},${Math.max(0, Math.min(1, a))})`;
const mix = (a: Rgb, b: Rgb, t: number): Rgb =>
  [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

/**
 * Orbit's voice as one self-lit aurora orb. Mode and audio levels steer it every frame from a
 * ref, so audio never re-renders React and a mode change blends instead of restarting the loop.
 */
export function VoiceOrbit({ controls, mode, muted }: {
  controls: RefObject<VoiceAgentControls | null>; mode: VoiceMode; muted: boolean;
}) {
  const root = useRef<HTMLCanvasElement>(null);
  const reduced = usePrefersReducedMotion();
  const live = useRef({ mode, muted, reduced });
  useEffect(() => { live.current = { mode, muted, reduced }; }, [mode, muted, reduced]);

  useEffect(() => {
    const canvas = root.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    let size = 0;
    let dpr = 1;
    const resize = () => {
      dpr = Math.min(2, window.devicePixelRatio || 1);
      size = canvas.clientWidth;
      canvas.width = canvas.height = Math.round(size * dpr);
    };
    // Re-checked every frame (in `tick`), not by a ResizeObserver: Cosmo's orb is resized as it
    // moves between slots, and a missed observation left a 5px backing store stretched to 58px.
    resize();
    let frame = 0;
    let input = 0;
    let output = 0;
    let weights = orbWeights(live.current.mode);
    let morph = 0;
    let spin = 0;
    let last = performance.now();
    const tick = (now: number) => {
      const dt = Math.min(now - last, 100);
      last = now;
      const { mode, muted, reduced } = live.current;
      if (canvas.clientWidth !== size || Math.min(2, window.devicePixelRatio || 1) !== dpr) resize();
      const levels = controls.current?.getLevels() ?? { input: 0, output: 0 };
      input = smoothVoiceLevel(input, muted ? 0 : levels.input, dt);
      output = smoothVoiceLevel(output, mode === "speaking" ? levels.output : 0, dt);
      weights = easeOrbWeights(weights, mode, dt);
      const p = orbParams(weights, input, output, reduced);
      // Phases accumulate so a speed change never makes the shape or lights jump.
      morph += (p.morphSpeed * dt) / 1000;
      spin += (p.lightSpeed * dt) / 1000;
      canvas.style.setProperty("--voice-input", String(input));
      canvas.style.setProperty("--voice-output", String(output));
      drawOrb(ctx, size, dpr, p, reduced ? 0 : now / 1000, morph, spin);
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(frame);
    };
  }, [controls]);

  return (
    <canvas
      ref={root}
      className="voice-orbit"
      data-mode={mode}
      data-muted={muted || undefined}
      data-reduced={reduced ? "" : undefined}
      aria-hidden="true"
    />
  );
}

function drawOrb(ctx: CanvasRenderingContext2D, size: number, dpr: number, p: OrbParams, t: number, morph: number, spin: number) {
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, size, size);
  if (!size) return;
  const c = size / 2;
  const R = size * 0.33 * (p.scale + p.breath * Math.sin(t * 1.6));
  const warm = Math.max(0, p.tint);
  const cool = Math.max(0, -p.tint);
  const glow = Math.max(0, p.glow + p.glowPulse * Math.sin(t * 3));
  ctx.globalAlpha = p.opacity;

  // Halo as a gradient, not shadowBlur: shadowBlur every frame is costly in Safari.
  const haloColor = mix(mix(VIOLET, PINK, warm), CYAN, cool);
  const halo = ctx.createRadialGradient(c, c, R * 0.8, c, c, R * (1.2 + 0.3 * glow));
  halo.addColorStop(0, rgba(haloColor, 0.6 * glow));
  halo.addColorStop(1, rgba(haloColor, 0));
  ctx.fillStyle = halo;
  ctx.fillRect(0, 0, size, size);

  ctx.beginPath();
  for (let i = 0; i <= 120; i++) {
    const a = (i / 120) * TAU;
    const shape = 0.5 * Math.sin(2 * a + morph * 0.9) + 0.35 * Math.sin(3 * a - morph * 1.3 + 1) + 0.25 * Math.sin(5 * a + morph * 1.7);
    const ripple = Math.sin(9 * a - t * 8) + 0.6 * Math.sin(13 * a + t * 6);
    const r = R * (1 + p.wobble * shape + p.ripple * ripple);
    if (i) ctx.lineTo(c + Math.cos(a) * r, c + Math.sin(a) * r);
    else ctx.moveTo(c + Math.cos(a) * r, c + Math.sin(a) * r);
  }
  ctx.closePath();
  const body = ctx.createRadialGradient(c, c, R * 0.1, c, c, R * 1.1);
  body.addColorStop(0, rgba(VIOLET, 0.9));
  body.addColorStop(0.75, BODY);
  body.addColorStop(1, BODY);
  ctx.fillStyle = body;
  ctx.fill();

  ctx.save();
  ctx.clip();
  ctx.globalCompositeOperation = "lighter";
  const lights: [Rgb, number][] = [
    [VIOLET, 0.55],
    [CYAN, 0.55 + 0.3 * cool - 0.2 * warm],
    [PINK, 0.55 + 0.3 * warm - 0.2 * cool],
  ];
  lights.forEach(([color, alpha], k) => {
    const angle = spin * (k % 2 ? -1 : 1) * (1 + k * 0.3) + k * 2.1;
    const d = R * (p.lightRadius + 0.1 * Math.sin(morph * 0.7 + k));
    const x = c + Math.cos(angle) * d;
    const y = c + Math.sin(angle) * d;
    const light = ctx.createRadialGradient(x, y, 0, x, y, R * 0.8);
    light.addColorStop(0, rgba(color, alpha * (0.7 + 0.6 * glow)));
    light.addColorStop(1, rgba(color, 0));
    ctx.fillStyle = light;
    ctx.fillRect(0, 0, size, size);
  });
  const hx = c - R * 0.35;
  const hy = c - R * 0.42;
  const shine = ctx.createRadialGradient(hx, hy, 0, hx, hy, R * 0.5);
  shine.addColorStop(0, "rgba(255,255,255,0.28)");
  shine.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = shine;
  ctx.fillRect(0, 0, size, size);
  ctx.restore();
  ctx.globalAlpha = 1;
}
