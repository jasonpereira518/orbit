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
import { galaxyBackdropZoom, type GalaxyBackdropData } from "@/lib/graph/galaxy-dust";
import { cn } from "@/lib/utils";

/**
 * The galaxy's bitmap is coarse on purpose: it is a haze and a scatter of dust, smooth
 * everywhere, so a 2048px square magnified to any zoom looks the same as a sharper one would.
 */
const GALAXY_BACKDROP_MAX_BACKING_PX = 2048;

/**
 * Below this zoom the backdrop's image is a layer of its own that keeps its raster scale.
 * Without that, zooming out re-rasters a layer as large as the whole galaxy at every step, and
 * near the end of the gesture the compositor thread stalls for 30–150 ms (measured at 2,500 and
 * 10,000 contacts: min fps 29.9 → 6.7; with the layer promoted, 59.5). It is gated to the
 * zoomed-out views because a promoted layer under the stars makes the stars painted over it
 * overlap-promote too (the cost PR #301 removed with its own images); up here the sky is
 * summary dots and a few hundred nodes, and at 0.18–0.34 it measured +2 layers.
 */
const GALAXY_BACKDROP_OWN_LAYER_BELOW_ZOOM = 0.3;

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
    // The backing scale is min(zoom·dpr, cap/width), and the cap binds at nearly every zoom a
    // real network reaches, so the pixels stop changing with the camera. Holding the zoom at the
    // step where the cap binds makes every later quarter-octave step the same job, which
    // `alreadyDrawn` skips.
    const effZoom = galaxyBackdropZoom(zoom, data.width, dpr, GALAXY_BACKDROP_MAX_BACKING_PX);
    if (alreadyDrawn(drawn.current, data, effZoom, dpr)) return;
    return drawNowUnlessHidden(canvas, () => {
      drawnOnce.current = true;
      drawn.current = { data, zoom: effZoom, dpr };
      render({ kind: "galaxy", data, zoom: effZoom, dpr, maxBackingPx: GALAXY_BACKDROP_MAX_BACKING_PX });
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
        style={{
          width: data.width,
          height: data.height,
          maxWidth: "none",
          willChange: zoom < GALAXY_BACKDROP_OWN_LAYER_BELOW_ZOOM ? "transform" : undefined,
        }}
      />
    </>
  );
}

export const GalaxyBackdropNode = memo(GalaxyBackdropNodeComponent);
