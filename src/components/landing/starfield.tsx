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
};

function prefersReducedMotion() {
  if (typeof window === "undefined") return false;
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

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
          const opacity = t < 0.15 ? t / 0.15 : 1 - (t - 0.15) / 0.85;

          if (opacity <= 0 || x > width + 40 || y > height + 40) {
            return false;
          }

          const tailX = x - Math.cos(shot.angle) * shot.len;
          const tailY = y - Math.sin(shot.angle) * shot.len;
          const streak = ctx!.createLinearGradient(tailX, tailY, x, y);
          streak.addColorStop(0, "rgba(232, 243, 241, 0)");
          streak.addColorStop(0.7, `rgba(196, 220, 230, ${opacity * 0.45})`);
          streak.addColorStop(1, `rgba(255, 255, 255, ${opacity * 0.95})`);

          ctx!.strokeStyle = streak;
          ctx!.lineWidth = 1.5;
          ctx!.lineCap = "round";
          ctx!.beginPath();
          ctx!.moveTo(tailX, tailY);
          ctx!.lineTo(x, y);
          ctx!.stroke();

          ctx!.beginPath();
          ctx!.fillStyle = `rgba(255, 255, 255, ${opacity})`;
          ctx!.arc(x, y, 1.4, 0, Math.PI * 2);
          ctx!.fill();

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
