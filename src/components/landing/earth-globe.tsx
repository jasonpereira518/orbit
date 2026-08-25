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

/** Pointer tug. The globe turns under the mouse but never leaves its mark:
 * the drag is spent entirely on rotation, so the planet stays exactly where
 * the choreography puts it, on the ring or anywhere else.
 *
 * Radians of turn per pixel of pull, before the cap bites. Set so the first
 * few pixels of movement already show — the globe answering the hand is the
 * whole point, and a rate low enough to need a deliberate sweep reads as the
 * drag not working. */
const DRAG_RATE = 0.008;
/** Hard ceilings on the turn — a nudge of the surface, not a globe being
 * spun. Yaw rides on top of the axial spin; pitch nods the axis, and gets
 * the smaller allowance because tipping the axis is the more conspicuous of
 * the two. */
const DRAG_YAW_MAX = 0.28;
const DRAG_PITCH_MAX = 0.19;
/** Slack around the silhouette, so the orbit-pose globe is still grabbable. */
const DRAG_HIT_PAD = 10;
/** Spring carrying the turn to the pointer, and back to true on release.
 * Stiff enough to sit under the cursor rather than trail it, and damped well
 * under critical so the release rebounds past true and swings back — the
 * globe reads as sprung rather than as merely undoing the drag. Letting go
 * mid-sweep adds the stored velocity on top, for a longer throw. */
const DRAG_STIFFNESS = 340;
const DRAG_DAMPING = 14;
/** Fixed physics step, so a dropped frame can't blow the spring up. */
const DRAG_STEP = 1 / 120;

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
 * It also owns the pointer tug: a mouse can turn the globe a little way under
 * its own axis, and letting go springs it back to true. The tug is rotation
 * only and capped — the planet never leaves the mark `earthAt` gives it, at
 * any point in the scene, so the drag cannot pull it off the ring.
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

    // Carries the pitch half of the pointer tug. It sits above the axial tilt
    // so a vertical pull nods the whole axis, and below `root` so it is not
    // multiplied by the radius scale.
    const nudge = new Group();
    nudge.add(tilt);

    const root = new Group();
    root.add(nudge);
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

    // Where the choreography last put the globe, in frame space. The pointer
    // hit test reads this rather than recomputing `earthAt`, so grabbing is
    // always tested against the pixels actually on screen.
    const pose = { x: 0, y: 0, r: 0 };

    // Pointer tug. `turn` is the live rotation offset, in radians, that the
    // spring carries — yaw from horizontal pull, pitch from vertical. It is
    // pure rotation: nothing here ever touches the globe's position, so the
    // drag cannot shift it off the ring or out of the finale's framing.
    const turn = { yaw: 0, pitch: 0, vYaw: 0, vPitch: 0 };
    const grab = { x: 0, y: 0 };
    const pointer = { x: 0, y: 0 };
    let dragId: number | null = null;
    // Axial spin, kept separate from earth.rotation.y so the drag's yaw can
    // ride on top of it without ever rewinding the spin itself.
    let spin = 0;

    /** Resistance curve: near 1:1 for the first pixels of pull, asymptotic at
     * the cap, so the turn has weight and can never run away into a free
     * spin — let go at any point and it is the same short trip back. */
    const rubber = (delta: number, max: number) =>
      max * Math.tanh((delta * DRAG_RATE) / max);

    const advanceDrag = (dt: number) => {
      let toYaw = 0;
      let toPitch = 0;
      if (dragId !== null) {
        toYaw = rubber(pointer.x - grab.x, DRAG_YAW_MAX);
        toPitch = rubber(pointer.y - grab.y, DRAG_PITCH_MAX);
      } else if (
        Math.abs(turn.yaw) < 1e-4 &&
        Math.abs(turn.pitch) < 1e-4 &&
        Math.abs(turn.vYaw) < 1e-4 &&
        Math.abs(turn.vPitch) < 1e-4
      ) {
        // Settled back to true — park it exactly there rather than letting the
        // spring hum against the floating-point floor for the rest of the page.
        turn.yaw = 0;
        turn.pitch = 0;
        turn.vYaw = 0;
        turn.vPitch = 0;
        return;
      }
      for (let left = dt; left > 0; left -= DRAG_STEP) {
        const h = Math.min(left, DRAG_STEP);
        turn.vYaw +=
          (-DRAG_STIFFNESS * (turn.yaw - toYaw) - DRAG_DAMPING * turn.vYaw) * h;
        turn.vPitch +=
          (-DRAG_STIFFNESS * (turn.pitch - toPitch) -
            DRAG_DAMPING * turn.vPitch) *
          h;
        turn.yaw += turn.vYaw * h;
        turn.pitch += turn.vPitch * h;
      }
    };

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
      pose.x = x;
      pose.y = y;
      pose.r = r;

      // The tug turns the globe and nothing else — position and scale below
      // are the choreography's alone.
      earth.rotation.y = spin + turn.yaw;
      nudge.rotation.x = turn.pitch;

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

    // Pointer tug. Listeners live on the frame, not the canvas: the canvas is
    // pointer-events:none (it covers the whole sticky frame, and the labels
    // above it have to stay selectable), so events bubble up from whatever is
    // underneath and get hit-tested against the globe's silhouette here.
    const framePoint = (e: PointerEvent) => {
      const box = frame.getBoundingClientRect();
      return { x: e.clientX - box.left, y: e.clientY - box.top };
    };

    const onGlobe = (e: PointerEvent) => {
      const { x, y } = framePoint(e);
      const reach = pose.r + DRAG_HIT_PAD;
      return Math.hypot(x - pose.x, y - pose.y) <= reach;
    };

    const onPointerDown = (e: PointerEvent) => {
      // Touch is deliberately excluded: a finger on the globe is a finger
      // scrolling the pin, and the pin's scroll is what plays the whole scene.
      if (e.pointerType === "touch" || dragId !== null || !onGlobe(e)) return;
      const point = framePoint(e);
      dragId = e.pointerId;
      grab.x = point.x;
      grab.y = point.y;
      pointer.x = point.x;
      pointer.y = point.y;
      frame.setPointerCapture(e.pointerId);
      frame.style.cursor = "grabbing";
      // Stops the drag from turning into a text or image selection.
      e.preventDefault();
    };

    const onPointerMove = (e: PointerEvent) => {
      if (dragId === e.pointerId) {
        const point = framePoint(e);
        pointer.x = point.x;
        pointer.y = point.y;
        return;
      }
      if (dragId !== null || e.pointerType === "touch") return;
      frame.style.cursor = onGlobe(e) ? "grab" : "";
    };

    const endDrag = (e: PointerEvent) => {
      if (dragId !== e.pointerId) return;
      dragId = null;
      frame.style.cursor = onGlobe(e) ? "grab" : "";
    };

    const onPointerLeave = () => {
      if (dragId === null) frame.style.cursor = "";
    };

    frame.addEventListener("pointerdown", onPointerDown);
    frame.addEventListener("pointerleave", onPointerLeave);
    frame.addEventListener("pointermove", onPointerMove);
    frame.addEventListener("pointerup", endDrag);
    frame.addEventListener("pointercancel", endDrag);
    frame.addEventListener("lostpointercapture", endDrag);

    // Same policy as the hero's planet loop (hero-solar-system.tsx): spin
    // only while on screen in a foreground tab. Paused-when-hidden is the
    // designed behaviour, not a bug.
    let raf = 0;
    let last = 0;
    const tick = (now: number) => {
      const dt = last ? Math.min((now - last) / 1000, 0.05) : 0;
      last = now;
      // The axial spin holds while a hand is on the globe: something being
      // held still should be still, and a planet creeping out from under the
      // cursor fights the drag instead of answering it. It picks up again
      // from where it stopped on release.
      if (dragId === null) spin += dt * SPIN_RATE * Math.PI * 2;
      advanceDrag(dt);
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
      frame.removeEventListener("pointerdown", onPointerDown);
      frame.removeEventListener("pointerleave", onPointerLeave);
      frame.removeEventListener("pointermove", onPointerMove);
      frame.removeEventListener("pointerup", endDrag);
      frame.removeEventListener("pointercancel", endDrag);
      frame.removeEventListener("lostpointercapture", endDrag);
      if (dragId !== null) {
        try {
          frame.releasePointerCapture(dragId);
        } catch {
          // The pointer is already gone; nothing to release.
        }
      }
      frame.style.cursor = "";
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
