"use client";

import { useCallback, useEffect, useRef, useState } from "react";

export type DragRect = { left: number; top: number; width: number; height: number };

/**
 * Drag a rectangle over an element, in viewport CSS pixels.
 *
 * Shared by the capture overlay (choosing a crop) and the annotator (choosing what to
 * hide), which are the same gesture over different pictures.
 *
 * Pointer capture is what makes it feel right: the drag survives leaving the image and even
 * the window, so a selection that starts near an edge does not die when the cursor
 * overshoots. Callers clamp the result to the image.
 */
export function useDragRect(options: {
  minSize: number;
  onCommit: (rect: DragRect) => void;
}) {
  const { minSize, onCommit } = options;
  const [rect, setRect] = useState<DragRect | null>(null);
  const [dragging, setDragging] = useState(false);
  const origin = useRef<{ x: number; y: number } | null>(null);
  const pending = useRef<{ x: number; y: number } | null>(null);
  const raf = useRef<number | null>(null);

  const rectFrom = (a: { x: number; y: number }, b: { x: number; y: number }): DragRect => ({
    left: Math.min(a.x, b.x),
    top: Math.min(a.y, b.y),
    width: Math.abs(a.x - b.x),
    height: Math.abs(a.y - b.y),
  });

  const flush = useCallback(() => {
    raf.current = null;
    const start = origin.current;
    const point = pending.current;
    if (!start || !point) return;
    setRect(rectFrom(start, point));
  }, []);

  const onPointerDown = useCallback((e: React.PointerEvent) => {
    if (e.button !== 0) return;
    // Stops the browser's native image-drag ghost, which otherwise hijacks the gesture.
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    origin.current = { x: e.clientX, y: e.clientY };
    pending.current = null;
    setRect({ left: e.clientX, top: e.clientY, width: 0, height: 0 });
    setDragging(true);
  }, []);

  const onPointerMove = useCallback(
    (e: React.PointerEvent) => {
      if (!dragging) return;
      pending.current = { x: e.clientX, y: e.clientY };
      // Coalesce to one state write per frame: pointermove fires far faster than paint.
      if (raf.current === null) raf.current = requestAnimationFrame(flush);
    },
    [dragging, flush]
  );

  const finish = useCallback(() => {
    if (!dragging) return;
    setDragging(false);
    if (raf.current !== null) {
      cancelAnimationFrame(raf.current);
      raf.current = null;
    }
    const start = origin.current;
    const point = pending.current;
    origin.current = null;
    pending.current = null;

    if (!start || !point) {
      // A click with no movement. Not an error — just nothing.
      setRect(null);
      return;
    }
    const next = rectFrom(start, point);
    if (next.width < minSize || next.height < minSize) {
      setRect(null);
      return;
    }
    setRect(next);
    onCommit(next);
  }, [dragging, minSize, onCommit]);

  /** Abandon an in-progress drag (Escape) without committing anything. */
  const cancel = useCallback(() => {
    if (raf.current !== null) {
      cancelAnimationFrame(raf.current);
      raf.current = null;
    }
    origin.current = null;
    pending.current = null;
    setDragging(false);
    setRect(null);
  }, []);

  useEffect(() => {
    return () => {
      if (raf.current !== null) cancelAnimationFrame(raf.current);
    };
  }, []);

  return {
    rect,
    setRect,
    dragging,
    cancel,
    handlers: {
      onPointerDown,
      onPointerMove,
      onPointerUp: finish,
      onPointerCancel: cancel,
    },
  };
}
