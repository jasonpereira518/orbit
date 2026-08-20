"use client";

import { useEffect, useRef } from "react";
import type { MotionValue } from "motion/react";
import {
  AdditiveBlending,
  AmbientLight,
  BufferAttribute,
  BufferGeometry,
  Color,
  DirectionalLight,
  DoubleSide,
  Group,
  Mesh,
  MeshStandardMaterial,
  Object3D,
  OrthographicCamera,
  Scene,
  ShaderMaterial,
  SphereGeometry,
  SRGBColorSpace,
  Texture,
  TextureLoader,
  Vector3,
  WebGLRenderer,
} from "three";
import {
  centreY,
  earthAt,
  RING_RATIO,
  stageSize,
  type Geom,
} from "@/components/landing/how-it-works-choreography";

/** Progressive texture tiers, coarsest first. The last one is only fetched
 * as the finale approaches — it is worth 1.4 MB for the full-bleed shot and
 * nothing at all for the 30px orbit pose. */
const TEX_LOW = "/landing/earth/earth-color-1024.webp";
const TEX_HIGH = "/landing/earth/earth-color-2048.webp";
const TEX_ULTRA = "/landing/earth/earth-color-4096.webp";

/** Progress at which the ultra tier starts loading — early enough to land
 * before the zoom, late enough that most visitors never pay for it. */
const ULTRA_AT = 0.6;

/** Axial tilt, in radians. Shallower than the real 23.4° — at this size the
 * true angle reads as the planet leaning over rather than as a tilt. */
const AXIAL_TILT = (11 * Math.PI) / 180;

/** Rotations per second. Slow enough that the spin reads as drift rather
 * than as a globe being turned. */
const SPIN_RATE = 0.045;

/** Arc the trail covers behind Earth, in radians (~31°). */
const TRAIL_SPAN = 0.55;
/** Half-thickness of the trail, in CSS px. Constant: this is a line drawn
 * along the ring, not a comet tail that fans out behind the body. */
const TRAIL_HALF_WIDTH = 1.25;
/** Segments along it. Enough that the taper stays smooth at any ring size. */
const TRAIL_SEGMENTS = 40;

/** Comet tail: one tapered ribbon laid along the ring behind Earth, with
 * both width and alpha falling off toward the tail. */
const TRAIL_VERT = /* glsl */ `
  attribute float aFade;
  varying float vFade;
  void main() {
    vFade = aFade;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const TRAIL_FRAG = /* glsl */ `
  uniform vec3 uColor;
  uniform float uStrength;
  varying float vFade;
  void main() {
    float a = vFade * uStrength;
    gl_FragColor = vec4(uColor * a, a);
  }
`;

/**
 * The Earth for the how-it-works pin: one lit sphere in an orthographic
 * scene whose units ARE the sticky frame's CSS pixels, so `earthAt`'s px
 * output drops straight in and the sphere sits exactly on the DOM ring.
 *
 * Sole writer of the globe (position, scale, spin, key light) — motion values
 * write only DOM. This component never re-renders from scroll: the rAF reads
 * `progress.get()` directly.
 *
 * Loaded only through earth-globe-mount.tsx, which owns every gate
 * (lg viewport, reduced motion, WebGL2, proximity).
 */
export function EarthGlobe({
  progress,
  depart,
  frameRef,
}: {
  progress: MotionValue<number>;
  depart: MotionValue<number>;
  frameRef: React.RefObject<HTMLElement | null>;
}) {
  const hostRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const host = hostRef.current;
    const frame = frameRef.current;
    if (!host || !frame) return;

    // The canvas is created here rather than rendered by React on purpose.
    // Cleanup force-loses the WebGL context, and a canvas whose context has
    // been force-lost can never hand out a working one again — so a
    // React-owned canvas would break on the second effect run (StrictMode in
    // dev, any remount in production): three reads getShaderPrecisionFormat()
    // off the dead context, gets null, and throws through the render tree.
    const canvas = document.createElement("canvas");
    canvas.setAttribute("aria-hidden", "true");
    canvas.style.cssText =
      "position:absolute;inset:0;width:100%;height:100%;pointer-events:none";
    host.appendChild(canvas);

    let renderer: WebGLRenderer;
    try {
      renderer = new WebGLRenderer({
        canvas,
        antialias: true,
        alpha: true,
        powerPreference: "low-power",
      });
    } catch {
      // Context creation can still fail behind a passing WebGL2 probe
      // (blocklisted GPU, too many live contexts). Leave the frame empty
      // rather than taking the page down with it.
      canvas.remove();
      return;
    }
    // 2 rather than 1.75: the finale magnifies one patch of the sphere across
    // the whole frame, where the extra device pixels actually show.
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.outputColorSpace = SRGBColorSpace;

    const scene = new Scene();
    const camera = new OrthographicCamera(-1, 1, 1, -1, 0.1, 4000);
    camera.position.z = 1000;

    // Unit sphere; the root group's scale carries the real radius, so one
    // geometry serves both the 30px orbit pose and the full-bleed finale.
    // Segment count is set by the finale — at 30px nothing below 32 would
    // show, but a coarse silhouette is obvious once it fills the frame.
    const sphere = new SphereGeometry(1, 128, 80);

    const surface = new MeshStandardMaterial({
      roughness: 0.92,
      metalness: 0,
    });
    const earth = new Mesh(sphere, surface);

    const tilt = new Group();
    tilt.rotation.z = AXIAL_TILT;
    tilt.add(earth);

    const root = new Group();
    root.add(tilt);
    scene.add(root);

    // Trail line. It lives beside `root` rather than inside it: its vertices
    // are absolute world pixels along the ring, and root's scale carries
    // Earth's radius, which would multiply them.
    const trailGeo = new BufferGeometry();
    const trailPos = new Float32Array((TRAIL_SEGMENTS + 1) * 2 * 3);
    const trailFade = new Float32Array((TRAIL_SEGMENTS + 1) * 2);
    const trailIdx: number[] = [];
    for (let i = 0; i < TRAIL_SEGMENTS; i++) {
      const a = i * 2;
      trailIdx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
    for (let i = 0; i <= TRAIL_SEGMENTS; i++) {
      // Taper: 1 at Earth, 0 at the tail, biased so the head stays solid.
      const fade = Math.pow(1 - i / TRAIL_SEGMENTS, 1.4);
      trailFade[i * 2] = fade;
      trailFade[i * 2 + 1] = fade;
    }
    trailGeo.setAttribute("position", new BufferAttribute(trailPos, 3));
    trailGeo.setAttribute("aFade", new BufferAttribute(trailFade, 1));
    trailGeo.setIndex(trailIdx);
    const trailMaterial = new ShaderMaterial({
      uniforms: {
        uColor: { value: new Color(0xf2c14e) },
        uStrength: { value: 0 },
      },
      vertexShader: TRAIL_VERT,
      fragmentShader: TRAIL_FRAG,
      side: DoubleSide,
      blending: AdditiveBlending,
      transparent: true,
      depthWrite: false,
    });
    const trail = new Mesh(trailGeo, trailMaterial);
    trail.frustumCulled = false;
    trail.position.z = -1;
    scene.add(trail);

    // Deep blue rather than black on the night side — a fully unlit
    // hemisphere reads as a hole punched in the starfield.
    scene.add(new AmbientLight(0x24406e, 0.32));
    // Near-white daylight. The previous cream cast read as a yellow tint over
    // the whole planet once it got large; the warmth in the scene should come
    // from the sun disc beside it, not from the light on the continents.
    const key = new DirectionalLight(0xfffdfa, 2.0);
    const keyDir = new Vector3();
    const keyTarget = new Object3D();
    key.target = keyTarget;
    scene.add(key, keyTarget);

    // Progressive texture: show the coarsest tier as soon as it lands, then
    // replace it as finer ones arrive. Ranked rather than last-write-wins,
    // because a warm cache can deliver these in any order and a 1024 landing
    // on top of a 4096 would undo the finale.
    const loader = new TextureLoader();
    let disposed = false;
    let currentRank = -1;
    let ultraRequested = false;
    const textures: Texture[] = [];
    const maxAniso = renderer.capabilities.getMaxAnisotropy();

    const applyTexture = (rank: number) => (tex: Texture) => {
      if (disposed || rank <= currentRank) {
        tex.dispose();
        return;
      }
      currentRank = rank;
      tex.colorSpace = SRGBColorSpace;
      tex.anisotropy = maxAniso;
      const previous = surface.map;
      surface.map = tex;
      surface.needsUpdate = true;
      textures.push(tex);
      if (previous) {
        previous.dispose();
        textures.splice(textures.indexOf(previous), 1);
      }
      draw();
    };

    loader.load(TEX_LOW, applyTexture(0));
    loader.load(TEX_HIGH, applyTexture(1));

    // Cached frame geometry. Layout is read here and in the ResizeObserver
    // only — never inside the rAF.
    const geom: Geom = { w: 0, h: 0, ringR: 0 };

    const measure = () => {
      geom.w = frame.clientWidth;
      geom.h = frame.clientHeight;
      geom.ringR = stageSize(geom.w, geom.h) * RING_RATIO;

      renderer.setSize(geom.w, geom.h, false);
      camera.left = -geom.w / 2;
      camera.right = geom.w / 2;
      camera.top = geom.h / 2;
      camera.bottom = -geom.h / 2;
      camera.updateProjectionMatrix();
    };

    const draw = () => {
      const p = progress.get();
      const { x, y, r, theta, onRing, light } = earthAt(p, geom, depart.get());
      // Frame space (origin top-left, y down) → world space (centred, y up).
      root.position.set(x - geom.w / 2, geom.h / 2 - y, 0);
      root.scale.setScalar(r);
      keyTarget.position.copy(root.position);
      keyDir.set(light[0], light[1], light[2]);
      key.position.copy(root.position).addScaledVector(keyDir, 4000);

      // The finale is the only pose where texel density matters; start the
      // fetch a beat early so the swap never happens mid-zoom.
      if (!ultraRequested && p > ULTRA_AT) {
        ultraRequested = true;
        loader.load(TEX_ULTRA, applyTexture(2));
      }

      trailMaterial.uniforms.uStrength.value = onRing * 0.95;
      if (onRing > 0.001) {
        // Ring centre in world space — the composition sits below the frame
        // centre by half the header clearance, so it needs the same offset
        // the DOM stage uses.
        const ringCy = geom.h / 2 - centreY(geom.h);

        for (let i = 0; i <= TRAIL_SEGMENTS; i++) {
          const t = i / TRAIL_SEGMENTS;
          const a = theta - t * TRAIL_SPAN;
          const sin = Math.sin(a);
          const cos = Math.cos(a);
          const hw = TRAIL_HALF_WIDTH;
          const px = geom.ringR * sin;
          const py = ringCy + geom.ringR * cos;
          // Offset along the radius, so the ribbon hugs the ring.
          const o = i * 6;
          trailPos[o] = px - sin * hw;
          trailPos[o + 1] = py - cos * hw;
          trailPos[o + 2] = 0;
          trailPos[o + 3] = px + sin * hw;
          trailPos[o + 4] = py + cos * hw;
          trailPos[o + 5] = 0;
        }
        trailGeo.attributes.position.needsUpdate = true;
      }

      renderer.render(scene, camera);
    };

    measure();
    draw();

    const ro = new ResizeObserver(() => {
      measure();
      draw();
    });
    ro.observe(frame);

    // Same policy as the hero's planet loop (hero-solar-system.tsx): spin
    // only while on screen in a foreground tab. Paused-when-hidden is the
    // designed behaviour, not a bug.
    let raf = 0;
    let last = 0;
    const tick = (now: number) => {
      const dt = last ? Math.min((now - last) / 1000, 0.05) : 0;
      last = now;
      earth.rotation.y += dt * SPIN_RATE * Math.PI * 2;
      draw();
      raf = requestAnimationFrame(tick);
    };

    let inView = true;
    const sync = () => {
      cancelAnimationFrame(raf);
      last = 0;
      if (!document.hidden && inView) raf = requestAnimationFrame(tick);
    };
    const io = new IntersectionObserver((entries) => {
      inView = entries[0]?.isIntersecting ?? true;
      sync();
    });
    io.observe(frame);
    document.addEventListener("visibilitychange", sync);
    sync();

    return () => {
      disposed = true;
      cancelAnimationFrame(raf);
      document.removeEventListener("visibilitychange", sync);
      io.disconnect();
      ro.disconnect();
      for (const tex of textures) tex.dispose();
      sphere.dispose();
      surface.dispose();
      trailGeo.dispose();
      trailMaterial.dispose();
      renderer.dispose();
      // Browsers cap live WebGL contexts; a leaked one here means the second
      // visit to this page in a session renders nothing.
      renderer.forceContextLoss();
      canvas.remove();
    };
  }, [progress, depart, frameRef]);

  return (
    <div
      ref={hostRef}
      aria-hidden
      className="pointer-events-none absolute inset-0"
    />
  );
}
