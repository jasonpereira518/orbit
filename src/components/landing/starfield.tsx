"use client";

import { useEffect, useRef } from "react";
import { usePrefersReducedMotion } from "@/lib/use-prefers-reduced-motion";
import { STAR_GOLD, STAR_WHITE, paintSpace } from "@/lib/sky-palette";
import {
  STARFIELD_PULSE_EVENT,
  type StarfieldPulseDetail,
} from "@/lib/starfield-events";

type Star = {
  x: number;
  /** Position within the virtual field, NOT the viewport. See FIELD_MULT. */
  y: number;
  r: number;
  a: number;
  twinkle: number;
  phase: number;
  gold: boolean;
  bloom: boolean;
  /**
   * Interactive-only state: the star's current displacement from rest, in viewport px,
   * and how lit it is (0..1). Applied AFTER the field wrap, so a star crossing the seam
   * carries its offset with it. Always zero when the sky is not interactive.
   */
  ox: number;
  oy: number;
  glow: number;
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

/** One signup burst: a ring expanding from where the form's button was. */
type Pulse = { x: number; y: number; start: number };

/** The star field is this many viewports tall and wraps vertically. The
 * canvas itself stays viewport-sized: sizing it to the page's scrollHeight
 * (~10,000px here) would allocate a ~300MB backing store at DPR 2 and blow
 * past iOS Safari's canvas-area cap, where the canvas silently blanks. */
const FIELD_MULT = 2;
/** Stars drift at a fraction of scroll speed, so the sky reads as far away.
 * The field repeats every FIELD_MULT / PARALLAX ≈ 5.7 viewports — once on a
 * page this long, and invisible in a landmark-free random field. */
const PARALLAX = 0.35;
/** One star per this many virtual px² — raise it to thin the sky out. Cap
 * keeps the per-frame arc count bounded on ultrawide displays. */
const STAR_AREA = 2650;
const STAR_CAP = 1400;

/* ── The gravity well (interactive skies only) ──
 *
 * Stars within WELL_RADIUS of the pointer lean toward it and brighten, then ease
 * back once it moves on. The target displacement is a FRACTION of the star's
 * distance to the pointer, scaled by a smoothstep falloff, so it goes to zero at
 * the cursor itself: stars gather around the pointer, they never pile onto it.
 * The release rate is deliberately slower than the attack — a sky that snaps
 * back reads as magnetism; one that lingers reads as gravity. */
const WELL_RADIUS = 220;
const WELL_RADIUS_SQ = WELL_RADIUS * WELL_RADIUS;
const WELL_PULL = 0.4;
/** Rates in s⁻¹, applied as `1 - e^(-rate·dt)` so a dropped frame lands in the
 * same place as two normal ones. */
const WELL_ATTACK = 6;
const WELL_RELEASE = 3.2;
const WELL_GLOW = 0.6;
const WELL_RADIUS_BOOST = 0.9;
/** Above this much glow a star also gets a soft halo arc. */
const HALO_MIN = 0.55;
/** Offsets under this are snapped to zero, which is what lets the loop notice
 * the sky has fully settled and go back to the plain (non-interactive) path. */
const SETTLE_EPS = 0.05;
/** A tab that was hidden for a minute must not integrate a minute of motion. */
const DT_MAX = 0.05;

/* ── The signup pulse ── */
const PULSE_MS = 1100;
const PULSE_RADIUS = 360;
/** Half-width of the band of stars the ring is currently pushing. */
const PULSE_BAND = 70;
const PULSE_PUSH = 34;
/** Crisper than the well, so the ring reads as a wavefront passing through. */
const PULSE_RATE = 14;
const PULSE_SHOOTERS = 4;
const PULSE_CAP = 3;

/* Nebulae, the base gradient and the corner vignette all live in
 * `lib/sky-palette.ts` now: the warp stage cross-fades into this exact
 * image at the end of a lift-off, and a half-shade of drift between the two
 * shows up as a visible seam at the moment the user is looking at the sky. */

/**
 * `interactive` adds the cursor gravity well and listens for the signup pulse
 * (`lib/starfield-events.ts`). Off by default, and when off this component binds
 * no pointer listeners and runs exactly the per-star work it always has — the
 * landing, pricing and docs skies are shared with the warp stages and must not
 * drift. Under reduced motion the prop is ignored entirely: the single static
 * frame stays static.
 */
export function Starfield({ interactive = false }: { interactive?: boolean }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const reduced = usePrefersReducedMotion();

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    // Any interactivity at all (the pulse works on every device) versus the pointer
    // well, which is for fine pointers only: a finger occludes what it bends, and a
    // well that follows a scrolling thumb just jitters.
    const well = interactive && !reduced;
    const hoverOk =
      well && window.matchMedia("(hover: hover) and (pointer: fine)").matches;

    let raf = 0;
    let stars: Star[] = [];
    let shooters: ShootingStar[] = [];
    let nextShot = 0;
    let width = 0;
    let height = 0;
    let fieldH = 0;
    let dpr = 1;
    // The base gradient plus the nebulae are several full-screen radial
    // fills. Rebuilding those every frame was the most expensive op in the
    // loop, so they are rendered once per resize and blitted thereafter.
    let bg: HTMLCanvasElement | null = null;

    // Interactive state. `settled` is what keeps the idle cost equal to a plain
    // sky: once the pointer has left and every offset has decayed to nothing, the
    // whole well block is skipped until something disturbs it again.
    let px = 0;
    let py = 0;
    let pointerActive = false;
    let settled = true;
    let lastNow = 0;
    let pulses: Pulse[] = [];

    function paintBackground() {
      const off = document.createElement("canvas");
      off.width = Math.floor(width * dpr);
      off.height = Math.floor(height * dpr);
      const bctx = off.getContext("2d");
      if (!bctx) return;
      bctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      paintSpace(bctx, width, height);
      bg = off;
    }

    function resize() {
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      width = window.innerWidth;
      height = window.innerHeight;
      fieldH = height * FIELD_MULT;
      canvas!.width = Math.floor(width * dpr);
      canvas!.height = Math.floor(height * dpr);
      canvas!.style.width = `${width}px`;
      canvas!.style.height = `${height}px`;
      ctx!.setTransform(dpr, 0, 0, dpr, 0, 0);

      paintBackground();

      const count = Math.min(Math.floor((width * fieldH) / STAR_AREA), STAR_CAP);
      stars = Array.from({ length: count }, () => {
        const gold = Math.random() < 0.04;
        return {
          x: Math.random() * width,
          y: Math.random() * fieldH,
          r: Math.random() * 1.4 + 0.3,
          a: Math.random() * 0.55 + 0.25,
          twinkle: Math.random() * 0.008 + 0.004,
          phase: Math.random() * Math.PI * 2,
          gold,
          bloom: gold && Math.random() < 0.35,
          ox: 0,
          oy: 0,
          glow: 0,
        };
      });

      if (reduced) draw(performance.now());
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
      nextShot = now + Math.random() * 2800 + 2200;
    }

    /**
     * The pulse's shooters: a fan leaving the button upward, toward the hero,
     * rather than the ambient ones' lazy top-left-to-bottom-right drift. Bypasses
     * the two-at-a-time cap on purpose — this is the sky answering a click.
     */
    function spawnBurstShooter(x: number, y: number, i: number) {
      const angle =
        -Math.PI / 2 + (i - (PULSE_SHOOTERS - 1) / 2) * 0.7 + (Math.random() - 0.5) * 0.3;
      shooters.push({
        x: x + Math.cos(angle) * 24,
        y: y + Math.sin(angle) * 24,
        len: Math.random() * 50 + 60,
        speed: Math.random() * 5 + 9,
        life: 0,
        maxLife: Math.random() * 12 + 22,
        angle,
      });
    }

    function onPulse(e: Event) {
      const { x, y } = (e as CustomEvent<StarfieldPulseDetail>).detail;
      if (pulses.length >= PULSE_CAP) pulses.shift();
      const now = performance.now();
      pulses.push({ x, y, start: now });
      for (let i = 0; i < PULSE_SHOOTERS; i++) spawnBurstShooter(x, y, i);
      // Keep the ambient spawner quiet for a beat so the burst is the only streak.
      nextShot = now + 2000;
      settled = false;
    }

    /** Gold bloom and ring for each live pulse. Painted under the stars so
     * their bodies stay crisp on top of the wash. */
    function paintPulses(now: number) {
      for (const p of pulses) {
        const t = (now - p.start) / PULSE_MS;
        const fade = 1 - t;
        const ringR = PULSE_RADIUS * (1 - Math.pow(1 - t, 3));
        if (ringR < 1) continue;

        const bloom = ctx!.createRadialGradient(p.x, p.y, 0, p.x, p.y, ringR);
        bloom.addColorStop(0, `rgba(${STAR_GOLD}, ${0.22 * fade * fade})`);
        bloom.addColorStop(0.5, `rgba(${STAR_GOLD}, ${0.06 * fade})`);
        bloom.addColorStop(1, `rgba(${STAR_GOLD}, 0)`);
        ctx!.fillStyle = bloom;
        ctx!.beginPath();
        ctx!.arc(p.x, p.y, ringR, 0, Math.PI * 2);
        ctx!.fill();

        ctx!.strokeStyle = `rgba(${STAR_GOLD}, ${0.4 * fade})`;
        ctx!.lineWidth = 1.5 + 2 * fade;
        ctx!.beginPath();
        ctx!.arc(p.x, p.y, ringR, 0, Math.PI * 2);
        ctx!.stroke();
      }
    }

    function draw(now: number) {
      ctx!.clearRect(0, 0, width, height);
      // A zero-size viewport at mount (hidden tab being restored, prerender) produces a
      // zero-size bg canvas, and drawImage throws InvalidStateError on those — which
      // would take down the whole page tree, not just the backdrop.
      if (bg && bg.width > 0 && bg.height > 0) {
        ctx!.drawImage(bg, 0, 0, width, height);
      }

      // Read scroll once per frame rather than binding a scroll listener —
      // the value is only ever consumed here.
      const yOff = reduced ? 0 : (window.scrollY * PARALLAX) % fieldH;

      // Interactive bookkeeping. Cheap enough to run unconditionally; the
      // per-star block below is what `active` gates.
      const dt = lastNow ? Math.min(DT_MAX, (now - lastNow) / 1000) : 0;
      lastNow = now;
      if (pulses.length > 0) pulses = pulses.filter((p) => now - p.start < PULSE_MS);
      const active = well && (pointerActive || pulses.length > 0 || !settled);
      const kAttack = 1 - Math.exp(-WELL_ATTACK * dt);
      const kRelease = 1 - Math.exp(-WELL_RELEASE * dt);
      const kPulse = 1 - Math.exp(-PULSE_RATE * dt);
      let anyMoving = false;

      if (active && pulses.length > 0) paintPulses(now);

      for (const s of stars) {
        // Rest position on screen, after the wrap.
        const sy = ((s.y - yOff) % fieldH + fieldH) % fieldH;

        let x = s.x;
        let y = sy;
        let r = s.r;
        let alpha = reduced
          ? s.a
          : s.a * (0.65 + 0.35 * Math.sin(now * s.twinkle + s.phase));

        if (!active) {
          // The plain sky: exactly the work a non-interactive starfield does.
          if (y < -8 || y > height + 8) continue;
        } else {
          // A star well outside the viewport must not keep integrating a stale
          // offset it picked up before scrolling away — reset it instead, so it
          // re-enters at rest.
          if (sy < -WELL_RADIUS || sy > height + WELL_RADIUS) {
            s.ox = 0;
            s.oy = 0;
            s.glow = 0;
            continue;
          }

          let tx = 0;
          let ty = 0;
          let tg = 0;
          let rate = kRelease;

          if (pointerActive) {
            const dx = px - s.x;
            const dy = py - sy;
            const d2 = dx * dx + dy * dy;
            if (d2 < WELL_RADIUS_SQ) {
              const t = 1 - Math.sqrt(d2) / WELL_RADIUS;
              const f = t * t * (3 - 2 * t);
              tx = dx * WELL_PULL * f;
              ty = dy * WELL_PULL * f;
              tg = f;
              rate = kAttack;
            }
          }

          for (const p of pulses) {
            const t = (now - p.start) / PULSE_MS;
            const ringR = PULSE_RADIUS * (1 - Math.pow(1 - t, 3));
            const dx = s.x - p.x;
            const dy = sy - p.y;
            const reach = ringR + PULSE_BAND;
            if (dx > reach || dx < -reach || dy > reach || dy < -reach) continue;
            const d = Math.sqrt(dx * dx + dy * dy);
            if (d < 1) continue;
            const band = 1 - Math.abs(d - ringR) / PULSE_BAND;
            if (band <= 0) continue;
            const fade = 1 - t;
            const push = band * PULSE_PUSH * fade;
            tx += (dx / d) * push;
            ty += (dy / d) * push;
            if (band * fade > tg) tg = band * fade;
            if (kPulse > rate) rate = kPulse;
          }

          s.ox += (tx - s.ox) * rate;
          s.oy += (ty - s.oy) * rate;
          s.glow += (tg - s.glow) * rate;

          if (
            s.ox < SETTLE_EPS &&
            s.ox > -SETTLE_EPS &&
            s.oy < SETTLE_EPS &&
            s.oy > -SETTLE_EPS &&
            s.glow < SETTLE_EPS
          ) {
            s.ox = 0;
            s.oy = 0;
            s.glow = 0;
          } else {
            anyMoving = true;
          }

          x = s.x + s.ox;
          y = sy + s.oy;
          // Cull on the DRAWN position, not the rest one.
          if (y < -8 || y > height + 8) continue;

          if (s.glow > 0) {
            alpha = Math.min(1, alpha * (1 + WELL_GLOW * s.glow));
            r = s.r + WELL_RADIUS_BOOST * s.glow;
            if (s.glow > HALO_MIN) {
              // One soft arc rather than a shadow: shadowBlur is the expensive
              // call in this loop and is reserved for the few bloom stars.
              ctx!.beginPath();
              ctx!.fillStyle = s.gold
                ? `rgba(${STAR_GOLD}, ${0.16 * s.glow})`
                : `rgba(${STAR_WHITE}, ${0.16 * s.glow})`;
              ctx!.arc(x, y, r * 2.6 + 1.5, 0, Math.PI * 2);
              ctx!.fill();
            }
          }
        }

        if (s.bloom) {
          ctx!.shadowBlur = 6;
          ctx!.shadowColor = `rgba(${STAR_GOLD}, 0.8)`;
        }
        ctx!.beginPath();
        ctx!.fillStyle = s.gold
          ? `rgba(${STAR_GOLD}, ${alpha})`
          : `rgba(${STAR_WHITE}, ${alpha})`;
        ctx!.arc(x, y, r, 0, Math.PI * 2);
        ctx!.fill();
        if (s.bloom) ctx!.shadowBlur = 0;
      }

      if (active) settled = !anyMoving;

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

          // Both bounds on both axes: the ambient streaks only ever travel
          // down-right, but the pulse's fan leaves upward.
          if (
            opacity <= 0 ||
            x > width + 40 ||
            y > height + 40 ||
            x < -40 ||
            y < -40
          ) {
            return false;
          }

          const tailX = x - Math.cos(shot.angle) * shot.len;
          const tailY = y - Math.sin(shot.angle) * shot.len;
          const streak = ctx!.createLinearGradient(tailX, tailY, x, y);
          streak.addColorStop(0, `rgba(${STAR_WHITE}, 0)`);
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

    // Don't burn battery repainting a starfield in a background tab.
    function onVisibility() {
      cancelAnimationFrame(raf);
      pointerActive = false;
      if (!document.hidden && !reduced) {
        raf = requestAnimationFrame(draw);
      }
    }

    // Pointer tracking. On `window`, because the canvas itself is
    // pointer-events:none so the page beneath stays clickable. `clientX/Y` are
    // CSS px, which is the space the DPR transform leaves the context in.
    function onPointerMove(e: PointerEvent) {
      if (e.pointerType === "touch") return;
      px = e.clientX;
      py = e.clientY;
      pointerActive = true;
      settled = false;
    }
    // `pointerleave` on window is unreliable; a `pointerout` with no
    // relatedTarget is the pointer leaving the document for browser chrome or
    // another window. `blur` covers cmd-tab with the cursor still parked here.
    function onPointerOut(e: PointerEvent) {
      if (e.relatedTarget === null) pointerActive = false;
    }
    function onBlur() {
      pointerActive = false;
    }

    // Listeners attach before the first draw so that if the viewport is zero-sized at
    // mount, the resize event that gives it real dimensions can still repair the field.
    window.addEventListener("resize", resize);
    document.addEventListener("visibilitychange", onVisibility);
    if (well) window.addEventListener(STARFIELD_PULSE_EVENT, onPulse);
    if (hoverOk) {
      window.addEventListener("pointermove", onPointerMove, { passive: true });
      document.addEventListener("pointerout", onPointerOut);
      window.addEventListener("blur", onBlur);
    }

    resize();
    nextShot = performance.now() + 800;
    draw(performance.now());
    return () => {
      window.removeEventListener("resize", resize);
      document.removeEventListener("visibilitychange", onVisibility);
      if (well) window.removeEventListener(STARFIELD_PULSE_EVENT, onPulse);
      if (hoverOk) {
        window.removeEventListener("pointermove", onPointerMove);
        document.removeEventListener("pointerout", onPointerOut);
        window.removeEventListener("blur", onBlur);
      }
      cancelAnimationFrame(raf);
    };
  }, [reduced, interactive]);

  return (
    <canvas
      ref={canvasRef}
      aria-hidden
      className="pointer-events-none fixed inset-0 h-full w-full"
    />
  );
}
