"use client";

import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogPortal } from "@/components/ui/dialog";
import { useDragRect, type DragRect } from "@/components/feedback/use-drag-rect";
import { MIN_SELECTION_PX, type CapturedFrame, type CropRect } from "@/lib/screenshot-capture";

const TOOLBAR_H = 64;
const PAD = 32;

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

/**
 * Pick the part of a captured frame worth keeping.
 *
 * The frame is already taken by the time this mounts — see `FeedbackWidget.addScreenshot`.
 * That ordering is what makes the coordinate maths trivial: the selection is expressed in
 * the DISPLAYED image's space, and the only transform between it and the frame is one
 * uniform scale. `devicePixelRatio`, scroll offset and `window.innerWidth` never enter it,
 * which is also why sharing the whole desktop instead of the tab is not a failure — the
 * overlay letterboxes whatever arrived and the same division maps the rectangle into it.
 */
export function ScreenshotCaptureOverlay({
  frame,
  onCancel,
  onConfirm,
}: {
  frame: CapturedFrame;
  onCancel: () => void;
  onConfirm: (crop: CropRect) => void;
}) {
  const imgRef = useRef<HTMLImageElement>(null);
  const [display, setDisplay] = useState<{ w: number; h: number; fit: number } | null>(null);
  /**
   * The painted image's viewport rect, kept in state rather than read off the ref during
   * render. The drag hook reports viewport coordinates, so both the marquee's offsets and
   * the crop maths need this — and reading `.current` mid-render is exactly the pattern
   * that goes stale when the overlay re-renders for another reason.
   */
  const [imgBox, setImgBox] = useState<{ left: number; top: number } | null>(null);
  const [announced, setAnnounced] = useState("");

  // Explicit pixel dimensions rather than `object-contain`, so the rendered box IS the
  // painted box and mapping back is one division instead of reverse-engineering a letterbox.
  useLayoutEffect(() => {
    const measure = () => {
      const fit = Math.min(
        (window.innerWidth - PAD * 2) / frame.width,
        (window.innerHeight - PAD * 2 - TOOLBAR_H) / frame.height,
        // Never upscale: a magnified screenshot lies about how sharp it is.
        1
      );
      setDisplay({ w: Math.round(frame.width * fit), h: Math.round(frame.height * fit), fit });
      const box = imgRef.current?.getBoundingClientRect();
      if (box) setImgBox({ left: box.left, top: box.top });
    };
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [frame.width, frame.height]);

  const toCrop = useCallback(
    (selection: DragRect): CropRect => {
      if (!imgBox || !display) return { x: 0, y: 0, w: frame.width, h: frame.height };
      const x = clamp(Math.round((selection.left - imgBox.left) / display.fit), 0, frame.width);
      const y = clamp(Math.round((selection.top - imgBox.top) / display.fit), 0, frame.height);
      return {
        x,
        y,
        w: clamp(Math.round(selection.width / display.fit), 1, frame.width - x),
        h: clamp(Math.round(selection.height / display.fit), 1, frame.height - y),
      };
    },
    [display, imgBox, frame.width, frame.height]
  );

  // Letting go IS the confirmation. There was a "Use selection" step here first; it read as
  // ceremony, because by the time you release the button you have already decided what you
  // want. The whole-screenshot button below stays as the no-drag path.
  const { rect, dragging, cancel, handlers } = useDragRect({
    minSize: MIN_SELECTION_PX,
    onCommit: (selection) => {
      const crop = toCrop(selection);
      setAnnounced(`Selected ${crop.w} by ${crop.h} pixels.`);
      onConfirm(crop);
    },
  });

  const confirm = useCallback(() => {
    if (rect) onConfirm(toCrop(rect));
    else onConfirm({ x: 0, y: 0, w: frame.width, h: frame.height });
  }, [rect, toCrop, onConfirm, frame.width, frame.height]);

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Escape" && dragging) {
        // Cancel the DRAG, not the overlay. A second Escape closes, via Base UI.
        e.stopPropagation();
        e.preventDefault();
        cancel();
        return;
      }
      if (e.key === "Enter") {
        e.preventDefault();
        confirm();
      }
    },
    [dragging, cancel, confirm]
  );

  // Re-measure once the explicit width/height have been applied: on the first pass the
  // <img> has not been laid out at its final size yet.
  useEffect(() => {
    if (!display) return;
    const box = imgRef.current?.getBoundingClientRect();
    if (box) setImgBox({ left: box.left, top: box.top });
  }, [display]);

  return (
    <Dialog open modal onOpenChange={(open) => !open && onCancel()}>
      <DialogPortal>
        <DialogPrimitive.Backdrop className="fixed inset-0 z-[60] bg-black/80" />
        <DialogPrimitive.Popup
          className="fixed inset-0 z-[60] flex flex-col items-center justify-center gap-4 outline-none"
          aria-label="Select the area to include"
          aria-describedby="feedback-capture-hint"
          onKeyDown={onKeyDown}
        >
          <p id="feedback-capture-hint" className="sr-only">
            Drag to select an area of the screenshot. Press Enter to use the whole
            screenshot, or Escape to cancel.
          </p>
          <div className="sr-only" aria-live="polite">
            {announced}
          </div>

          <div
            className="relative select-none"
            style={{
              width: display?.w,
              height: display?.h,
              cursor: "crosshair",
              touchAction: "none",
            }}
            {...handlers}
          >
            {/* eslint-disable-next-line @next/next/no-img-element -- a blob: frame of the
                user's own screen, with no remote origin for next/image to optimise. */}
            <img
              ref={imgRef}
              src={frame.previewUrl}
              alt="Screenshot to crop"
              draggable={false}
              className="h-full w-full rounded-md"
            />
            {rect && (
              <div
                className="pointer-events-none absolute outline-2 outline-primary"
                style={{
                  // One element with an enormous spread shadow is the cheapest possible
                  // scrim-with-a-hole; four positioned panels thrash layout on every frame.
                  boxShadow: "0 0 0 9999px rgba(0,0,0,0.55)",
                  left: rect.left - (imgBox?.left ?? 0),
                  top: rect.top - (imgBox?.top ?? 0),
                  width: rect.width,
                  height: rect.height,
                }}
              />
            )}
          </div>

          <div className="flex items-center gap-3 rounded-full bg-popover px-4 py-2 text-popover-foreground shadow-lg">
            <span className="text-xs text-muted-foreground">
              Drag any area to attach it
            </span>
            {/* Initial focus, and the equal-status path: nothing in the payload is out of
                reach without a mouse. */}
            <Button type="button" size="sm" autoFocus onClick={confirm}>
              Use whole screenshot
            </Button>
            <Button type="button" size="sm" variant="ghost" onClick={onCancel}>
              Cancel
            </Button>
          </div>
        </DialogPrimitive.Popup>
      </DialogPortal>
    </Dialog>
  );
}
