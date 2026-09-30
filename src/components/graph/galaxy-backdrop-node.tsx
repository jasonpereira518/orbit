"use client";

import { memo, useLayoutEffect, useRef } from "react";
import { useStore, type NodeProps } from "@xyflow/react";
import { useCameraMoving } from "@/components/graph/camera-motion";
import {
  alreadyDrawn,
  drawNowUnlessHidden,
  useSkyBitmap,
  type DrawnCanvas,
} from "@/components/graph/graph-nodes";
import type { GalaxyBackdropData } from "@/lib/graph/galaxy-dust";
import { cn } from "@/lib/utils";

/**
 * The galaxy's bitmap is coarse on purpose: it is a haze and a scatter of dust, smooth
 * everywhere, so a 2048px square magnified to any zoom looks the same as a sharper one would.
 */
const GALAXY_BACKDROP_MAX_BACKING_PX = 2048;

/**
 * The galaxy behind the whole sky — warm bulge, cool disk haze, dark lanes and dust along the
 * chains of related clusters — as one more worker-drawn image, beneath everything else.
 *
 * Drawn exactly as `NebulaWashNodeComponent` is (see it, and `useSkyBitmap`, for why): world
 * units at the camera's quarter-octave zoom, held still while the camera moves, redrawn when it
 * stops, a canvas only until the first image is ready. Pointer-transparent, so the pane
 * answers every click and hover on it.
 */
function GalaxyBackdropNodeComponent({ data }: NodeProps & { data: GalaxyBackdropData }) {
  const { canvasRef, imgRef, imageShown, render } = useSkyBitmap();
  const zoom = useStore((s) =>
    Math.pow(2, Math.round(Math.log2(Math.max(s.transform[2], 0.01)) * 4) / 4)
  );
  const moving = useCameraMoving();
  const drawnOnce = useRef(false);
  const drawn = useRef<DrawnCanvas | null>(null);

  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    // Never skip the first draw: an empty canvas is a sky with no galaxy in it.
    if (moving && drawnOnce.current) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    if (alreadyDrawn(drawn.current, data, zoom, dpr)) return;
    return drawNowUnlessHidden(canvas, () => {
      drawnOnce.current = true;
      drawn.current = { data, zoom, dpr };
      render({ kind: "galaxy", data, zoom, dpr, maxBackingPx: GALAXY_BACKDROP_MAX_BACKING_PX });
    });
  }, [data, zoom, moving, canvasRef, render]);

  return (
    <>
      <canvas
        ref={canvasRef}
        aria-hidden
        className={cn(
          "constellation-galaxy-backdrop pointer-events-none",
          imageShown ? "hidden" : "block"
        )}
        style={{ width: data.width, height: data.height }}
      />
      {/* eslint-disable-next-line @next/next/no-img-element -- a local bitmap, not an asset */}
      <img
        ref={imgRef}
        alt=""
        aria-hidden
        draggable={false}
        className={cn(
          "constellation-galaxy-backdrop pointer-events-none select-none",
          imageShown ? "block" : "hidden"
        )}
        style={{ width: data.width, height: data.height, maxWidth: "none" }}
      />
    </>
  );
}

export const GalaxyBackdropNode = memo(GalaxyBackdropNodeComponent);
