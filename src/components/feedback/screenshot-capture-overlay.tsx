"use client";

import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogPortal } from "@/components/ui/dialog";
import { useDragRect, type DragRect } from "@/components/feedback/use-drag-rect";
import {
  MIN_SELECTION_PX,
  fitGeometry,
  selectionToCrop,
  type CapturedFrame,
  type FitGeometry,
  type CropRect,
} from "@/lib/screenshot-capture";

/**
 * Pick the part of a captured frame worth keeping.
 *
 * The frame is already taken by the time this mounts — see `FeedbackWidget.addScreenshot`.
 * That ordering is what keeps the mapping to one scale and one offset: the pointer reports
 * viewport coordinates, the still is placed at a known position in those same coordinates,
 * so `devicePixelRatio` and scroll offset never enter it. Sharing a whole desktop instead
 * of this tab still works — the aspect ratios differ, so the still is letterboxed rather
 * than cropped, and every part of it can be reached by the pointer.
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
  const [geometry, setGeometry] = useState<FitGeometry>(() =>
    fitGeometry(frame, { width: window.innerWidth, height: window.innerHeight })
  );
  const [announced, setAnnounced] = useState("");

  useEffect(() => {
    const measure = () =>
      setGeometry(fitGeometry(frame, { width: window.innerWidth, height: window.innerHeight }));
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

          {/* The drag surface is the whole viewport, not just the still. The still is inset
              from the edges, and a drag that starts or ends in that margin is clamped into
              the frame by `selectionToCrop` — so the outermost pixels stay reachable
              without having to land the pointer exactly on the picture's edge. */}
          <div
            className="absolute inset-0 select-none"
            style={{ cursor: "crosshair", touchAction: "none" }}
            {...handlers}
          >
            {/* The ring and shadow are what make the margin read as deliberate: without an
                edge, a screenshot of this app sitting on top of this app is indistinguishable
                from the app itself, and the inset just looks like the window is misaligned. */}
            {/* eslint-disable-next-line @next/next/no-img-element -- a blob: frame of the
                user's own screen, with no remote origin for next/image to optimise. */}
            <img
              src={frame.previewUrl}
              alt="Screenshot to crop"
              draggable={false}
              className="pointer-events-none absolute max-w-none rounded-lg shadow-2xl ring-1 ring-white/15"
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

          {/* Floats over the backdrop rather than taking layout from the still — but the
              still is no longer underneath it: `fitGeometry` keeps a `CAPTURE_TOOLBAR_PX`
              band clear along the bottom for exactly this bar, which used to sit on the
              picture and hide whatever was behind it. That constant mirrors this markup —
              the `bottom-6` offset and the pill's own height — so changing either means
              changing both. */}
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
