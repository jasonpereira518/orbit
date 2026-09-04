"use client";

import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogPortal } from "@/components/ui/dialog";
import { useDragRect, type DragRect } from "@/components/feedback/use-drag-rect";
import {
  MIN_SELECTION_PX,
  coverGeometry,
  selectionToCrop,
  type CapturedFrame,
  type CoverGeometry,
  type CropRect,
} from "@/lib/screenshot-capture";

/**
 * Pick the part of a captured frame worth keeping.
 *
 * The frame is already taken by the time this mounts — see `FeedbackWidget.addScreenshot`.
 * That ordering is what keeps the mapping to one scale and one offset: the pointer reports
 * viewport coordinates, the still is placed at a known position in those same coordinates,
 * so `devicePixelRatio` and scroll offset never enter it. Sharing a whole desktop instead
 * of this tab still works — the aspect ratios differ, so the still overflows the window and
 * is centred, and everything visible remains selectable at true scale.
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
  // Lazy initialiser rather than an effect: this overlay only ever mounts client-side
  // (`ssr: false`), and computing on the first render means the still is placed before the
  // first paint instead of flashing an empty backdrop for a frame.
  const [geometry, setGeometry] = useState<CoverGeometry>(() =>
    coverGeometry(frame, { width: window.innerWidth, height: window.innerHeight })
  );
  const [announced, setAnnounced] = useState("");

  useEffect(() => {
    const measure = () =>
      setGeometry(coverGeometry(frame, { width: window.innerWidth, height: window.innerHeight }));
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [frame]);

  const toCrop = useCallback(
    (selection: DragRect): CropRect => selectionToCrop(selection, geometry, frame),
    [geometry, frame]
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
    onConfirm({ x: 0, y: 0, w: frame.width, h: frame.height });
  }, [onConfirm, frame.width, frame.height]);

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

  const live = rect ? toCrop(rect) : null;

  return (
    <Dialog open modal onOpenChange={(open) => !open && onCancel()}>
      <DialogPortal>
        {/* No scrim of its own: the still covers the whole window, and dimming behind
            something opaque only shows at the edges when a desktop share overflows. */}
        <DialogPrimitive.Backdrop className="fixed inset-0 z-[60] bg-black/40" />
        <DialogPrimitive.Popup
          className="fixed inset-0 z-[60] overflow-hidden outline-none"
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

          {/* The drag surface is the whole viewport, so a selection can start and end
              anywhere — including hard against an edge, which a padded, centred box made
              impossible to reach. */}
          <div
            className="absolute inset-0 select-none"
            style={{ cursor: "crosshair", touchAction: "none" }}
            {...handlers}
          >
            {/* eslint-disable-next-line @next/next/no-img-element -- a blob: frame of the
                user's own screen, with no remote origin for next/image to optimise. */}
            <img
              src={frame.previewUrl}
              alt="Screenshot to crop"
              draggable={false}
              className="pointer-events-none absolute max-w-none"
              style={{
                left: geometry.left,
                top: geometry.top,
                width: frame.width * geometry.scale,
                height: frame.height * geometry.scale,
              }}
            />

            {rect && (
              <div
                className="pointer-events-none absolute outline-2 outline-primary"
                style={{
                  // One element with an enormous spread shadow is the cheapest possible
                  // scrim-with-a-hole; four positioned panels thrash layout on every frame.
                  boxShadow: "0 0 0 9999px rgba(0,0,0,0.55)",
                  // The drag surface is `inset-0`, so pointer coordinates ARE offsets
                  // within it. No conversion, and nothing to go stale.
                  left: rect.left,
                  top: rect.top,
                  width: rect.width,
                  height: rect.height,
                }}
              />
            )}
          </div>

          {/* Floats over the still rather than taking layout from it, which is what lets
              the picture occupy the entire window. */}
          <div className="pointer-events-none absolute inset-x-0 bottom-6 flex justify-center">
            <div className="pointer-events-auto flex items-center gap-3 rounded-full bg-popover px-4 py-2 text-popover-foreground shadow-lg">
              <span className="text-xs tabular-nums text-muted-foreground">
                {live ? `${live.w} × ${live.h}` : "Drag any area to attach it"}
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
          </div>
        </DialogPrimitive.Popup>
      </DialogPortal>
    </Dialog>
  );
}
