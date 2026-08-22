"use client";

import dynamic from "next/dynamic";
import { useEffect, useState } from "react";
import { motion, useTransform, type MotionValue } from "motion/react";
import { earthAt, type Geom } from "@/components/landing/how-it-works-choreography";

// Deliberately not in landing-visuals.tsx: the dynamic() calls there fire at
// hydration, and three has no business being fetched for a section three
// screens down. The proximity gate below owns when this chunk loads.
const EarthGlobe = dynamic(
  () =>
    import("@/components/landing/earth-globe").then((m) => ({
      default: m.EarthGlobe,
    })),
  { ssr: false, loading: () => null }
);

let webglSupport: boolean | null = null;

function hasWebGL2() {
  if (webglSupport !== null) return webglSupport;
  try {
    const probe = document.createElement("canvas");
    webglSupport = Boolean(probe.getContext("webgl2"));
  } catch {
    webglSupport = false;
  }
  return webglSupport;
}

/**
 * Static-art stand-in for browsers without WebGL2. Rides the same `earthAt`
 * output, so the whole choreography still plays — only the axial spin and the
 * real terminator are missing.
 */
function EarthSprite({
  progress,
  depart,
  geom,
}: {
  progress: MotionValue<number>;
  depart: MotionValue<number>;
  geom: Geom;
}) {
  // Positioned from the top-left corner rather than a centre offset: `x`/`y`
  // and `translateX`/`translateY` are the same underlying property in motion,
  // so pairing a scrubbed `x` with a static `-50%` translate would drop one.
  const x = useTransform([progress, depart], (v: number[]) => {
    const e = earthAt(v[0] ?? 0, geom, v[1] ?? 0);
    return e.x - e.r;
  });
  const y = useTransform([progress, depart], (v: number[]) => {
    const e = earthAt(v[0] ?? 0, geom, v[1] ?? 0);
    return e.y - e.r;
  });
  const size = useTransform(
    [progress, depart],
    (v: number[]) => earthAt(v[0] ?? 0, geom, v[1] ?? 0).r * 2
  );

  return (
    <motion.img
      src="/landing/planets/earth.png"
      alt=""
      aria-hidden
      draggable={false}
      className="pointer-events-none absolute left-0 top-0 max-w-none"
      style={{ x, y, width: size, height: size }}
    />
  );
}

/**
 * Owns every gate in front of the WebGL island: viewport, motion preference,
 * WebGL2, and proximity. `enabled` carries the lg + reduced-motion decision
 * from the pin, which already computes both.
 */
export function EarthGlobeMount({
  progress,
  depart,
  frameRef,
  enabled,
  geom,
}: {
  progress: MotionValue<number>;
  depart: MotionValue<number>;
  frameRef: React.RefObject<HTMLElement | null>;
  enabled: boolean;
  geom: Geom;
}) {
  const [near, setNear] = useState(false);

  useEffect(() => {
    const frame = frameRef.current;
    if (!frame || !enabled || near) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) setNear(true);
      },
      // A viewport and a half of runway: the chunk and its texture are in
      // hand before the pin's first frame, without ever touching first load.
      { rootMargin: "150% 0px" }
    );
    io.observe(frame);
    return () => io.disconnect();
  }, [frameRef, enabled, near]);

  if (!enabled || !near) return null;
  if (!hasWebGL2())
    return <EarthSprite progress={progress} depart={depart} geom={geom} />;
  return <EarthGlobe progress={progress} depart={depart} frameRef={frameRef} />;
}
