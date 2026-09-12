"use client";

import { useEffect, type RefObject } from "react";
import {
  clampPan,
  panBy,
  zoomAt,
  type Camera,
  type Vec2,
  type WorldRect,
} from "@/lib/graph/sky-camera";

/** 44pt is Apple's minimum target; this is its radius. */
export const TAP_TOLERANCE_PX = 22;
/** Past this much travel the gesture was a pan, not a tap. */
export const TAP_SLOP_PX = 8;
export const TAP_MS = 260;
export const DOUBLE_TAP_MS = 300;
export const DOUBLE_TAP_SLOP_PX = 24;
export const DOUBLE_TAP_FACTOR = 1.8;
/** Per 16.67ms frame. */
export const INERTIA_DECAY = 0.94;
export const INERTIA_MIN_PX_PER_FRAME = 0.06;
/** How much recent movement feeds the flick velocity. */
export const VELOCITY_WINDOW_MS = 80;
/**
 * Ceiling on a flick, in px per frame.
 *
 * A coast decays by INERTIA_DECAY per frame, so it travels roughly v / (1 - decay) —
 * about 17x its opening speed. Without a ceiling one fast sample can throw the sky most
 * of a screen-width past anything the finger suggested.
 */
export const MAX_FLICK_PX_PER_FRAME = 40;

/** `dt` is the time since the previous move, so a sample carries its own duration. */
export type Sample = { dx: number; dy: number; dt: number; t: number };

/**
 * How fast the finger was moving when it left the glass, in px per frame.
 *
 * Distance over the time those samples actually cover — NOT over the gap between the
 * oldest one and now. Measuring against `now` collapses to near-zero whenever the window
 * holds a single fresh sample, and a gentle 8px nudge before lifting then reads as
 * hundreds of px per frame and hurls the sky off-screen. Seen doing exactly that on an
 * iPhone; `scripts/smoke-graph-canvas.ts` pins the case.
 */
export function flickVelocity(samples: Sample[], now: number): Vec2 {
  const recent = samples.filter((s) => now - s.t < VELOCITY_WINDOW_MS);
  if (recent.length === 0) return { x: 0, y: 0 };

  let dx = 0;
  let dy = 0;
  let elapsed = 0;
  for (const s of recent) {
    dx += s.dx;
    dy += s.dy;
    elapsed += s.dt;
  }
  // One frame is the shortest interval a pointer stream can meaningfully report.
  elapsed = Math.max(elapsed, 16.67);

  const vx = (dx / elapsed) * 16.67;
  const vy = (dy / elapsed) * 16.67;

  const speed = Math.hypot(vx, vy);
  if (speed > MAX_FLICK_PX_PER_FRAME) {
    const scale = MAX_FLICK_PX_PER_FRAME / speed;
    return { x: vx * scale, y: vy * scale };
  }
  return { x: vx, y: vy };
}

export type SkyGestureHandlers = {
  /** Mutated in place and read by the draw loop — never React state. */
  cameraRef: RefObject<Camera>;
  bounds: () => WorldRect;
  pane: () => { width: number; height: number };
  onCameraChanged: () => void;
  onTap: (screen: Vec2) => void;
  /** Called when a gesture ends, so React can learn the camera at rest. */
  onSettled: (camera: Camera) => void;
  /** Under reduced motion there is no flick coast. */
  reducedMotion: boolean;
  /**
   * False turns the sky into a picture you can tap but not move: no pan, no pinch, no
   * double-tap zoom, no coast. For the dashboard preview, which sits inside a scrolling
   * page — a card that captured every drag would stop the page scrolling wherever a
   * finger happened to land on it.
   */
  movable: boolean;
  /** True while a camera tween owns the camera; a touch must cancel it. */
  cancelTween: () => void;
};

/**
 * Pan, pinch and tap on a canvas.
 *
 * Pointer Events rather than Touch Events: one code path covers finger, Pencil and a
 * trackpad on a narrow window, and pointer capture makes a drag that leaves the element
 * behave.
 *
 * The camera lives in a ref and the handlers mutate it directly. A `setState` per
 * `pointermove` at 120Hz, re-rendering a tree that holds thousands of contacts, is the
 * same class of failure this renderer exists to fix — so React only learns the camera
 * once the gesture settles.
 */
export function useSkyGestures(
  elementRef: RefObject<HTMLElement | null>,
  handlers: SkyGestureHandlers
) {
  useEffect(() => {
    const el = elementRef.current;
    if (!el) return;

    const pointers = new Map<number, Vec2>();
    let start: { x: number; y: number; t: number } | null = null;
    let travelled = 0;
    let lastTapAt = 0;
    let lastTapPoint: Vec2 | null = null;
    let samples: Sample[] = [];
    let lastMoveAt = 0;
    let inertiaRaf = 0;
    let pinchDistance = 0;
    let pinchMid: Vec2 | null = null;

    const localPoint = (e: PointerEvent): Vec2 => {
      const rect = el.getBoundingClientRect();
      return { x: e.clientX - rect.left, y: e.clientY - rect.top };
    };

    const commit = (next: Camera) => {
      const clamped = clampPan(next, handlers.bounds(), handlers.pane());
      handlers.cameraRef.current = clamped;
      handlers.onCameraChanged();
    };

    const stopInertia = () => {
      if (inertiaRaf) cancelAnimationFrame(inertiaRaf);
      inertiaRaf = 0;
    };

    /**
     * A flick coast. A map without one reads as broken on a phone — the sky stops dead
     * under your finger — and it is bounded by construction: the decay terminates the
     * loop, and any new touch cancels it.
     */
    const startInertia = () => {
      if (handlers.reducedMotion) return;
      const v = flickVelocity(samples, performance.now());
      let vx = v.x;
      let vy = v.y;
      if (Math.hypot(vx, vy) < INERTIA_MIN_PX_PER_FRAME) return;

      const step = () => {
        vx *= INERTIA_DECAY;
        vy *= INERTIA_DECAY;
        if (Math.hypot(vx, vy) < INERTIA_MIN_PX_PER_FRAME) {
          inertiaRaf = 0;
          handlers.onSettled(handlers.cameraRef.current);
          return;
        }
        commit(panBy(handlers.cameraRef.current, vx, vy));
        inertiaRaf = requestAnimationFrame(step);
      };
      inertiaRaf = requestAnimationFrame(step);
    };

    /**
     * Capture is an optimisation — it keeps a drag alive when the finger leaves the
     * canvas — and it is allowed to fail: it throws `NotFoundError` for a pointer id the
     * browser does not consider active. Unguarded, that throw happens before the pointer
     * is recorded and takes pan, pinch and tap down with it, so the map simply stops
     * responding. Never worth a dead chart.
     */
    const capture = (el: HTMLElement, pointerId: number) => {
      try {
        el.setPointerCapture?.(pointerId);
      } catch {
        // Uncaptured pointers still pan and tap; only edge-of-canvas drags suffer.
      }
    };


    const onPointerDown = (e: PointerEvent) => {
      stopInertia();
      handlers.cancelTween();
      capture(el, e.pointerId);
      pointers.set(e.pointerId, localPoint(e));

      if (pointers.size === 1) {
        const p = localPoint(e);
        start = { x: p.x, y: p.y, t: performance.now() };
        travelled = 0;
        samples = [];
        lastMoveAt = start.t;
      } else if (pointers.size === 2) {
        const [a, b] = [...pointers.values()];
        pinchDistance = Math.hypot(b.x - a.x, b.y - a.y);
        pinchMid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      }
    };

    const onPointerMove = (e: PointerEvent) => {
      if (!pointers.has(e.pointerId)) return;
      const prev = pointers.get(e.pointerId)!;
      const next = localPoint(e);
      pointers.set(e.pointerId, next);

      if (pointers.size === 1) {
        const dx = next.x - prev.x;
        const dy = next.y - prev.y;
        travelled += Math.hypot(dx, dy);
        const at = performance.now();
        samples.push({ dx, dy, dt: at - lastMoveAt, t: at });
        lastMoveAt = at;
        if (samples.length > 8) samples.shift();
        if (handlers.movable) commit(panBy(handlers.cameraRef.current, dx, dy));
        return;
      }

      if (pointers.size === 2 && pinchMid && handlers.movable) {
        const [a, b] = [...pointers.values()];
        const distance = Math.hypot(b.x - a.x, b.y - a.y);
        const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
        if (pinchDistance > 0 && distance > 0) {
          /**
           * Scale about the midpoint the fingers came FROM, then translate by how far
           * that midpoint moved. Anchoring at the new midpoint instead holds still
           * whatever happens to be under the finger's destination, and the sky creeps on
           * every pinch. Pinned by `scripts/smoke-graph-canvas.ts`.
           */
          const zoomed = zoomAt(
            handlers.cameraRef.current,
            pinchMid,
            distance / pinchDistance
          );
          commit(panBy(zoomed, mid.x - pinchMid.x, mid.y - pinchMid.y));
        }
        pinchDistance = distance;
        pinchMid = mid;
        // A pinch is never a tap, however little the midpoint moved.
        travelled = Infinity;
      }
    };

    const endPointer = (e: PointerEvent, cancelled: boolean) => {
      if (!pointers.has(e.pointerId)) return;
      const point = pointers.get(e.pointerId)!;
      pointers.delete(e.pointerId);
      try {
        el.releasePointerCapture?.(e.pointerId);
      } catch {
        // Symmetric with `capture` — releasing a pointer we never captured is not an error.
      }

      if (pointers.size === 1) {
        // Dropping from two fingers to one: re-seat the pan origin, or the remaining
        // finger jumps the sky by the gap between it and the old midpoint.
        const [only] = [...pointers.values()];
        start = { x: only.x, y: only.y, t: performance.now() };
        samples = [];
        lastMoveAt = start.t;
        pinchMid = null;
        pinchDistance = 0;
        return;
      }
      if (pointers.size > 0) return;

      const elapsed = start ? performance.now() - start.t : Infinity;
      const wasTap = !cancelled && travelled < TAP_SLOP_PX && elapsed < TAP_MS;

      if (wasTap) {
        const now = performance.now();
        const isDouble =
          now - lastTapAt < DOUBLE_TAP_MS &&
          lastTapPoint !== null &&
          Math.hypot(point.x - lastTapPoint.x, point.y - lastTapPoint.y) < DOUBLE_TAP_SLOP_PX;

        if (isDouble && handlers.movable) {
          lastTapAt = 0;
          lastTapPoint = null;
          commit(zoomAt(handlers.cameraRef.current, point, DOUBLE_TAP_FACTOR));
          handlers.onSettled(handlers.cameraRef.current);
        } else {
          lastTapAt = now;
          lastTapPoint = point;
          handlers.onTap(point);
        }
      } else if (!cancelled) {
        if (handlers.movable) startInertia();
      }

      if (!wasTap && cancelled) handlers.onSettled(handlers.cameraRef.current);
      start = null;
      pinchMid = null;
      pinchDistance = 0;
    };

    const onPointerUp = (e: PointerEvent) => endPointer(e, false);
    /**
     * iOS fires this when the system takes the gesture (an edge swipe, a notification).
     * Not clearing the map here leaves a phantom pointer, and the next one-finger drag
     * is treated as a pinch against a finger that is no longer on the glass.
     */
    const onPointerCancel = (e: PointerEvent) => endPointer(e, true);

    // Safari's proprietary pinch events still fire alongside pointer events and would
    // zoom the page itself. Non-passive so preventDefault is honoured.
    const blockGesture = (e: Event) => e.preventDefault();

    el.addEventListener("pointerdown", onPointerDown);
    el.addEventListener("pointermove", onPointerMove);
    el.addEventListener("pointerup", onPointerUp);
    el.addEventListener("pointercancel", onPointerCancel);
    el.addEventListener("dblclick", blockGesture);
    el.addEventListener("gesturestart", blockGesture, { passive: false });
    el.addEventListener("gesturechange", blockGesture, { passive: false });

    return () => {
      stopInertia();
      el.removeEventListener("pointerdown", onPointerDown);
      el.removeEventListener("pointermove", onPointerMove);
      el.removeEventListener("pointerup", onPointerUp);
      el.removeEventListener("pointercancel", onPointerCancel);
      el.removeEventListener("dblclick", blockGesture);
      el.removeEventListener("gesturestart", blockGesture);
      el.removeEventListener("gesturechange", blockGesture);
    };
  }, [elementRef, handlers]);
}
