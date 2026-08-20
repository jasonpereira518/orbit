"use client";

import { useEffect, useRef } from "react";

type Star = {
  x: number;
  y: number;
  r: number;
  a: number;
  twinkle: number;
  phase: number;
  gold: boolean;
  bloom: boolean;
};

type ShootingStar = {
  x: number;
  y: number;
  len: number;
  speed: number;
  life: number;
  maxLife: number;
  angle: number;
  flickerSeed: number;
  gold: boolean;
};

function prefersReducedMotion() {
  if (typeof window === "undefined") return false;
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

// Fast eased flash-in over the first 8% of life, then a graceful eased
// fade-out over the rest — a brighter "flash" at spawn instead of a flat
// linear ramp.
function shooterOpacity(t: number): number {
  if (t < 0.08) {
    const u = t / 0.08;
    return 1 - Math.pow(1 - u, 3);
  }
  const u = (t - 0.08) / 0.92;
  const eased = u < 0.5 ? 2 * u * u : 1 - Math.pow(-2 * u + 2, 2) / 2;
  return 1 - eased;
}

// Fixed fractions along the tail (tail -> head) sampled for the flicker
// dots — deterministic positions recomputed each frame, not moving
// sub-particles.
const FLICKER_FRACTIONS = [0.3, 0.55, 0.8];

export function Starfield() {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const reduced = prefersReducedMotion();
    let raf = 0;
    let stars: Star[] = [];
    let shooters: ShootingStar[] = [];
    let nextShot = 0;
    let width = 0;
    let height = 0;
    let dpr = 1;

    function resize() {
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      const parent = canvas!.parentElement;
      width = window.innerWidth;
      height = parent ? parent.scrollHeight : window.innerHeight;
      canvas!.width = Math.floor(width * dpr);
      canvas!.height = Math.floor(height * dpr);
      canvas!.style.width = `${width}px`;
      canvas!.style.height = `${height}px`;
      ctx!.setTransform(dpr, 0, 0, dpr, 0, 0);

      const count = Math.floor((width * height) / 2400);
      stars = Array.from({ length: Math.min(count, 1400) }, () => {
        const gold = Math.random() < 0.04;
        return {
          x: Math.random() * width,
          y: Math.random() * height,
          r: Math.random() * 1.4 + 0.3,
          a: Math.random() * 0.55 + 0.25,
          twinkle: Math.random() * 0.008 + 0.004,
          phase: Math.random() * Math.PI * 2,
          gold,
          bloom: gold && Math.random() < 0.35,
        };
      });
    }

    function spawnShooter(now: number) {
      shooters.push({
        x: Math.random() * width * 0.7 + width * 0.1,
        y: Math.random() * height * 0.35,
        len: Math.random() * 90 + 70,
        speed: Math.random() * 6 + 8,
        life: 0,
        maxLife: Math.random() * 28 + 22,
        angle: Math.PI / 4 + (Math.random() - 0.5) * 0.25,
        flickerSeed: Math.random() * Math.PI * 2,
        gold: Math.random() < 0.15,
      });
      nextShot = now + Math.random() * 9000 + 5000;
    }

    function draw(now: number) {
      ctx!.clearRect(0, 0, width, height);

      for (const s of stars) {
        const alpha = reduced
          ? s.a
          : s.a * (0.65 + 0.35 * Math.sin(now * s.twinkle + s.phase));
        const color = s.gold
          ? `rgba(242, 193, 78, ${alpha})`
          : `rgba(232, 243, 241, ${alpha})`;
        ctx!.beginPath();
        ctx!.fillStyle = color;
        if (s.bloom) {
          ctx!.shadowBlur = 6;
          ctx!.shadowColor = s.gold ? "rgba(242, 193, 78, 0.8)" : "rgba(232, 243, 241, 0.6)";
        } else {
          ctx!.shadowBlur = 0;
        }
        ctx!.arc(s.x, s.y, s.r, 0, Math.PI * 2);
        ctx!.fill();
      }
      ctx!.shadowBlur = 0;

      if (!reduced) {
        if (now >= nextShot && shooters.length < 2) {
          spawnShooter(now);
        }

        shooters = shooters.filter((shot) => {
          shot.life += 1;
          const t = shot.life / shot.maxLife;
          const dist = shot.speed * shot.life;
          const x = shot.x + Math.cos(shot.angle) * dist;
          const y = shot.y + Math.sin(shot.angle) * dist;
          const opacity = shooterOpacity(t);

          if (opacity <= 0 || x > width + 40 || y > height + 40) {
            return false;
          }

          const tailX = x - Math.cos(shot.angle) * shot.len;
          const tailY = y - Math.sin(shot.angle) * shot.len;
          const core = shot.gold
            ? { mid: "246, 210, 130", edge: "255, 244, 214" }
            : { mid: "196, 220, 230", edge: "255, 255, 255" };

          const streak = ctx!.createLinearGradient(tailX, tailY, x, y);
          streak.addColorStop(0, "rgba(232, 243, 241, 0)");
          streak.addColorStop(0.5, `rgba(${core.mid}, ${opacity * 0.35})`);
          streak.addColorStop(0.85, `rgba(${core.mid}, ${opacity * 0.6})`);
          streak.addColorStop(1, `rgba(${core.edge}, ${opacity * 0.95})`);

          // Wide, faint glow pass behind the crisp stroke (reuses the same
          // gradient — no extra allocation).
          ctx!.strokeStyle = streak;
          ctx!.lineCap = "round";
          ctx!.lineWidth = 4;
          ctx!.globalAlpha = opacity * 0.35;
          ctx!.beginPath();
          ctx!.moveTo(tailX, tailY);
          ctx!.lineTo(x, y);
          ctx!.stroke();
          ctx!.globalAlpha = 1;

          // Crisp main stroke.
          ctx!.lineWidth = 1.5;
          ctx!.beginPath();
          ctx!.moveTo(tailX, tailY);
          ctx!.lineTo(x, y);
          ctx!.stroke();

          // Flickering, particle-like tail: a few fixed-fraction points
          // along the tail whose brightness pulses via a deterministic
          // sine (seeded per-shooter), not per-frame randomness.
          for (let i = 0; i < FLICKER_FRACTIONS.length; i++) {
            const f = FLICKER_FRACTIONS[i];
            const px = tailX + (x - tailX) * f;
            const py = tailY + (y - tailY) * f;
            const pulse = 0.5 + 0.5 * Math.sin(now * 0.02 + shot.flickerSeed + i * 2.1);
            const pAlpha = opacity * pulse * 0.5 * f;
            if (pAlpha < 0.02) continue;
            ctx!.beginPath();
            ctx!.fillStyle = `rgba(${core.edge}, ${pAlpha})`;
            ctx!.arc(px, py, 0.8, 0, Math.PI * 2);
            ctx!.fill();
          }

          // Bloomed head, drawn last so it sits brightest/on top.
          ctx!.shadowBlur = 8;
          ctx!.shadowColor = shot.gold
            ? "rgba(246, 210, 130, 0.9)"
            : "rgba(255, 255, 255, 0.9)";
          ctx!.beginPath();
          ctx!.fillStyle = `rgba(${core.edge}, ${opacity})`;
          ctx!.arc(x, y, 1.6, 0, Math.PI * 2);
          ctx!.fill();
          ctx!.shadowBlur = 0;

          return true;
        });
      }

      if (!reduced) {
        raf = requestAnimationFrame(draw);
      }
    }

    resize();
    nextShot = performance.now() + 800;
    draw(performance.now());

    window.addEventListener("resize", resize);

    let resizeObserver: ResizeObserver | undefined;
    if (canvas.parentElement && typeof ResizeObserver !== "undefined") {
      resizeObserver = new ResizeObserver(() => resize());
      resizeObserver.observe(canvas.parentElement);
    }

    return () => {
      window.removeEventListener("resize", resize);
      resizeObserver?.disconnect();
      cancelAnimationFrame(raf);
    };
  }, []);

  return (
    <canvas
      ref={canvasRef}
      aria-hidden
      className="pointer-events-none absolute inset-0 h-full w-full"
    />
  );
}
