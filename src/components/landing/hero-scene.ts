/**
 * The hero's one WebGL scene: a star, eight textured worlds on three orbits, a real star map
 * behind them, and a comet that swings in at the end. Raw three, no React.
 *
 * Loaded only through a dynamic `import()` (hero-pin.tsx, and the bench page), so three stays
 * out of the landing page's first load. Nothing here may be value-imported by a component in
 * the page's static graph; shared numbers live in `hero-choreography.ts`.
 *
 * The scene is the sole writer of the canvas and of `transform` on the overlay anchors it is
 * handed. It never causes a React render: the rAF reads `progress()` and `liveDays()` itself.
 *
 * Under the production CSP this may fetch only same-origin files and may not use wasm, so:
 * textures go through `TextureLoader` (an `<img>`), the comet's model carries no embedded
 * image (see `scripts/optimize-landing-assets.ts`), and nothing is Draco, KTX2 or meshopt.
 */
import {
  AdditiveBlending,
  AmbientLight,
  BufferAttribute,
  BufferGeometry,
  CanvasTexture,
  DirectionalLight,
  DoubleSide,
  Group,
  LineBasicMaterial,
  LineLoop,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  PerspectiveCamera,
  PlaneGeometry,
  PointLight,
  Points,
  RingGeometry,
  Scene,
  ShaderMaterial,
  SphereGeometry,
  Sprite,
  SpriteMaterial,
  SRGBColorSpace,
  TextureLoader,
  Vector3,
  WebGLRenderer,
  type Material,
  type Texture,
} from "three";
import {
  BEATS,
  FOV,
  HERO_ASSETS,
  RINGS,
  RING_SPEED,
  WORLDS,
  cameraPose,
  cometAt,
  layoutFor,
  radiusForDays,
  type Layout,
} from "@/components/landing/hero-choreography";
import { HERO_STARS } from "@/components/landing/hero-stars";

export type HeroSceneOptions = {
  /** Scroll progress through the pin, 0 → 1. Read every frame. */
  progress: () => number;
  /** Days since the slider's person was last talked to. Read every frame. */
  liveDays: () => number;
  /** Overlay elements the scene positions, in frame pixels from the top left. */
  anchors: { rings: (HTMLElement | null)[]; live: HTMLElement | null };
  /** Phones and tablets: 1K maps only, a lower pixel ratio, no 4K sky. */
  light: boolean;
  /** Freeze the orbits at this many seconds and follow progress exactly, for captures. */
  fixedTime?: number;
  /** Force a layout instead of taking the frame's own, for captures. */
  layout?: Layout;
  /** The first complete frame has been drawn. */
  onReady: () => void;
  /** The GPU took the context away (true) or gave it back (false). */
  onLost: (lost: boolean) => void;
};

const GOLD = 0xf2c14e;
/**
 * The sky's own colour, under the stars: the navy of the page's starfield where the hero
 * frame dissolves into it. The Milky Way is added to this, not painted over it, so the hero
 * is the same deep space as the rest of the page and the hand-off has no black band.
 */
const SPACE = 0x0b1128;
const TAIL_LENGTH = 6;
const TAIL_WIDTH = 1.7;
/** How much larger the worlds are drawn from overhead, where true scale leaves them specks. */
const OVERHEAD_GROWTH = 0.8;

const TAIL_VERT = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;
/** Bright and narrow at the head, wide and gone by the end. */
const TAIL_FRAG = /* glsl */ `
  uniform vec3 uColor;
  uniform float uStrength;
  varying vec2 vUv;
  void main() {
    float along = 1.0 - vUv.x;
    float spread = mix(0.1, 0.5, vUv.x);
    float across = exp(-pow((vUv.y - 0.5) / spread, 2.0));
    float a = pow(along, 1.7) * across * uStrength;
    gl_FragColor = vec4(uColor * a, a);
  }
`;

/** Each star a soft round point. The slow shimmer is per star, so the sky never pulses. */
const STAR_VERT = /* glsl */ `
  attribute vec3 aColor;
  attribute float aSize;
  attribute float aSeed;
  uniform float uScale;
  uniform float uTime;
  varying vec3 vColor;
  void main() {
    vColor = aColor * (0.86 + 0.14 * sin(uTime * (0.5 + aSeed) + aSeed * 40.0));
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    gl_PointSize = aSize * uScale;
  }
`;
const STAR_FRAG = /* glsl */ `
  varying vec3 vColor;
  void main() {
    float d = length(gl_PointCoord - 0.5) * 2.0;
    float a = pow(max(0.0, 1.0 - d), 1.6);
    // Alpha 1: additive blending multiplies by it, and a soft point squared is no point.
    gl_FragColor = vec4(vColor * a, 1.0);
  }
`;

const scrub = (v: number, [a, b]: readonly [number, number]) => Math.min(1, Math.max(0, (v - a) / (b - a)));

/** A soft round falloff, drawn once: the star's corona and the comet's coma. */
function glowTexture(): CanvasTexture {
  const size = 256;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext("2d")!;
  const gradient = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  gradient.addColorStop(0, "rgba(255,255,255,1)");
  gradient.addColorStop(0.18, "rgba(255,255,255,0.55)");
  gradient.addColorStop(0.45, "rgba(255,255,255,0.12)");
  gradient.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, size, size);
  return new CanvasTexture(canvas);
}

export function mountHeroScene(host: HTMLElement, opts: HeroSceneOptions): () => void {
  // Created here, not by React: cleanup force-loses the context, and a canvas whose context
  // was force-lost can never hand out a working one again (StrictMode, any remount).
  const canvas = document.createElement("canvas");
  canvas.setAttribute("aria-hidden", "true");
  canvas.style.cssText = "position:absolute;inset:0;width:100%;height:100%;display:block";
  host.appendChild(canvas);

  let renderer: WebGLRenderer;
  try {
    renderer = new WebGLRenderer({ canvas, antialias: true, alpha: false, powerPreference: "high-performance" });
  } catch {
    // A passing WebGL2 probe does not guarantee a context (blocklisted GPU, too many live
    // ones). The poster underneath stays up.
    canvas.remove();
    return () => {};
  }
  const maxRatio = opts.light ? 1.5 : 2;
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, maxRatio));
  renderer.outputColorSpace = SRGBColorSpace;
  renderer.setClearColor(SPACE, 1);

  const scene = new Scene();
  const camera = new PerspectiveCamera(FOV, 1, 0.1, 1200);
  const disposables: { dispose: () => void }[] = [];
  const keep = <T extends { dispose: () => void }>(thing: T): T => {
    disposables.push(thing);
    return thing;
  };

  // --- Textures: coarsest first, each finer tier replacing it. Ranked, because a warm
  // cache can deliver them in any order and a 1K landing on a 2K would undo the upgrade.
  const loader = new TextureLoader();
  const maxAniso = renderer.capabilities.getMaxAnisotropy();
  const ranks = new Map<Material, number>();
  let disposed = false;
  const setMap = (material: MeshBasicMaterial | MeshStandardMaterial, rank: number, tex: Texture) => {
    if (disposed || rank <= (ranks.get(material) ?? -1)) {
      tex.dispose();
      return;
    }
    ranks.set(material, rank);
    tex.colorSpace = SRGBColorSpace;
    tex.anisotropy = maxAniso;
    material.map?.dispose();
    material.map = tex;
    material.needsUpdate = true;
  };
  const first: Promise<void>[] = [];
  const sharpen: (() => void)[] = [];
  const mapped = (material: MeshBasicMaterial | MeshStandardMaterial, urls: { low: string; high: string }) => {
    first.push(loader.loadAsync(urls.low).then((tex) => setMap(material, 0, tex)));
    sharpen.push(() => void loader.loadAsync(urls.high).then((tex) => setMap(material, 1, tex)).catch(() => {}));
  };

  // --- Sky: the Milky Way's glow as a texture, the real bright stars as points over it. Both
  // are in galactic coordinates (band along the equator), so one group tips them together:
  // the Milky Way crosses the hero frame on a diagonal instead of lying flat under the system.
  // Drawn first and never depth-tested, so the radius only has to clear the far plane.
  const sky = new Group();
  sky.rotation.set(1.05, 0.35, 0.5);
  scene.add(sky);
  const skyGeometry = keep(new SphereGeometry(600, 48, 32));
  // Mirrored in X so the map reads the right way round from inside, as a sky map is drawn.
  skyGeometry.scale(-1, 1, 1);
  const milkyMaterial = keep(
    new MeshBasicMaterial({ depthWrite: false, depthTest: false, blending: AdditiveBlending, transparent: true }),
  );
  const milkyWay = new Mesh(skyGeometry, milkyMaterial);
  milkyWay.renderOrder = -2;
  sky.add(milkyWay);
  mapped(milkyMaterial, HERO_ASSETS.milkyWay);

  const packed = Uint8Array.from(atob(HERO_STARS), (c) => c.charCodeAt(0));
  const starCount = packed.length / 6;
  const starPosition = new Float32Array(starCount * 3);
  const starColor = new Float32Array(starCount * 3);
  const starSize = new Float32Array(starCount);
  const starSeed = new Float32Array(starCount);
  for (let n = 0; n < starCount; n++) {
    const o = n * 6;
    // The same mapping the sphere above gives the texture, so points and glow line up.
    const phi = ((packed[o] | (packed[o + 1] << 8)) / 65535) * Math.PI * 2;
    const theta = ((packed[o + 2] | (packed[o + 3] << 8)) / 65535) * Math.PI;
    starPosition[n * 3] = 590 * Math.cos(phi) * Math.sin(theta);
    starPosition[n * 3 + 1] = 590 * Math.cos(theta);
    starPosition[n * 3 + 2] = 590 * Math.sin(phi) * Math.sin(theta);
    const bright = packed[o + 4] / 255;
    const warm = packed[o + 5] / 255;
    const level = 0.62 + 0.38 * Math.pow(bright, 0.7);
    // Blue-white through white to a warm orange, as star colours run.
    starColor[n * 3] = level * (warm < 0.5 ? 0.72 + 0.56 * warm : 1);
    starColor[n * 3 + 1] = level * (warm < 0.5 ? 0.82 + 0.36 * warm : 1.18 - 0.36 * warm);
    starColor[n * 3 + 2] = level * (warm < 0.5 ? 1 : 1.38 - 0.76 * warm);
    starSize[n] = 2 + 7 * Math.pow(bright, 2);
    starSeed[n] = (n * 0.61803) % 1;
  }
  const starGeometry = keep(new BufferGeometry());
  starGeometry.setAttribute("position", new BufferAttribute(starPosition, 3));
  starGeometry.setAttribute("aColor", new BufferAttribute(starColor, 3));
  starGeometry.setAttribute("aSize", new BufferAttribute(starSize, 1));
  starGeometry.setAttribute("aSeed", new BufferAttribute(starSeed, 1));
  const starMaterial = keep(
    new ShaderMaterial({
      uniforms: { uScale: { value: 1 }, uTime: { value: 0 } },
      vertexShader: STAR_VERT,
      fragmentShader: STAR_FRAG,
      blending: AdditiveBlending,
      transparent: true,
      depthWrite: false,
      depthTest: false,
    }),
  );
  const stars = new Points(starGeometry, starMaterial);
  stars.frustumCulled = false;
  stars.renderOrder = -1;
  sky.add(stars);

  // --- Star.
  const sphere = keep(new SphereGeometry(1, 64, 40));
  const sunMaterial = keep(new MeshBasicMaterial());
  const sun = new Mesh(sphere, sunMaterial);
  sun.scale.setScalar(1.15);
  scene.add(sun);
  mapped(sunMaterial, HERO_ASSETS.sun);

  const glow = keep(glowTexture());
  const coronaMaterial = keep(
    new SpriteMaterial({ map: glow, color: 0xffc56a, blending: AdditiveBlending, depthWrite: false, transparent: true }),
  );
  const corona = new Sprite(coronaMaterial);
  corona.scale.setScalar(10);
  scene.add(corona);
  // The surface map alone reads as a painted orange ball. A white-hot centre over it leaves
  // the colour at the limb, which is how a star photographs.
  const coreMaterial = keep(
    new SpriteMaterial({ map: glow, color: 0xfff1cc, blending: AdditiveBlending, depthWrite: false, transparent: true, opacity: 0.95 }),
  );
  const core = new Sprite(coreMaterial);
  core.scale.setScalar(3.4);
  scene.add(core);

  // `decay: 0` keeps the far worlds lit: a physical falloff would leave the outer ring black.
  scene.add(new PointLight(0xfff3dc, 2.6, 0, 0));
  // Deep blue, not black, on the night sides, or a far hemisphere reads as a hole in the sky.
  scene.add(new AmbientLight(0x29477a, 0.5));
  // A cool fill from wherever the camera is: a world between the camera and the star shows
  // its night side, and without this the nearest, largest one is a black disc.
  const fill = new DirectionalLight(0x9db6e6, 0.55);
  scene.add(fill);

  // --- Worlds.
  type World = { pivot: Group; body: Mesh; ring: number; phase: number; live: boolean; radius: number; size: number };
  const worlds: World[] = WORLDS.map((spec) => {
    const material = keep(new MeshStandardMaterial({ roughness: 0.94, metalness: 0 }));
    mapped(material, HERO_ASSETS.world(spec.id));
    const body = new Mesh(sphere, material);
    const tilt = new Group();
    tilt.rotation.z = 0.32;
    tilt.add(body);
    const pivot = new Group();
    pivot.add(tilt);
    if (spec.id === "saturn") {
      // The ring map is a strip: left edge is the inner radius. RingGeometry's own UVs are
      // planar, so each vertex is re-mapped by its distance from the centre.
      const inner = 1.3;
      const outer = 2.3;
      const geometry = keep(new RingGeometry(inner, outer, 128, 1));
      const position = geometry.attributes.position;
      const uv = geometry.attributes.uv;
      for (let i = 0; i < position.count; i++) {
        const reach = Math.hypot(position.getX(i), position.getY(i));
        uv.setXY(i, (reach - inner) / (outer - inner), 0.5);
      }
      const ringMaterial = keep(
        new MeshBasicMaterial({ side: DoubleSide, transparent: true, depthWrite: false, color: 0xd8c9a8 }),
      );
      first.push(loader.loadAsync(HERO_ASSETS.saturnRing).then((tex) => setMap(ringMaterial, 0, tex)));
      const rings = new Mesh(geometry, ringMaterial);
      rings.rotation.x = -Math.PI / 2;
      tilt.rotation.z = 0.46;
      tilt.add(rings);
    }
    scene.add(pivot);
    return { pivot, body, ring: spec.ring, phase: spec.phase, live: spec.live, radius: RINGS[spec.ring].r, size: spec.size };
  });

  // --- Orbit lines.
  const circle = new Float32Array(257 * 3);
  for (let i = 0; i <= 256; i++) {
    const a = (i / 256) * Math.PI * 2;
    circle[i * 3] = Math.cos(a);
    circle[i * 3 + 2] = Math.sin(a);
  }
  const circleGeometry = keep(new BufferGeometry());
  circleGeometry.setAttribute("position", new BufferAttribute(circle, 3));
  const lineMaterial = keep(new LineBasicMaterial({ color: GOLD, transparent: true, depthWrite: false }));
  for (const ring of RINGS) {
    const line = new LineLoop(circleGeometry, lineMaterial);
    line.scale.setScalar(ring.r);
    scene.add(line);
  }
  const liveLineMaterial = keep(new LineBasicMaterial({ color: 0xe8f3f1, transparent: true, depthWrite: false }));
  const liveLine = new LineLoop(circleGeometry, liveLineMaterial);
  scene.add(liveLine);

  // --- Comet: a tail and a coma now, the nucleus when the scroll gets near it.
  const comet = new Group();
  comet.visible = false;
  scene.add(comet);
  const tailMaterial = keep(
    new ShaderMaterial({
      uniforms: { uColor: { value: new Vector3(0.78, 0.9, 1.0) }, uStrength: { value: 0 } },
      vertexShader: TAIL_VERT,
      fragmentShader: TAIL_FRAG,
      side: DoubleSide,
      blending: AdditiveBlending,
      transparent: true,
      depthWrite: false,
    }),
  );
  const tailGeometry = keep(new PlaneGeometry(1, 1, 1, 1));
  tailGeometry.translate(0.5, 0, 0); // head at the origin, tail along +X
  const tail = new Mesh(tailGeometry, tailMaterial);
  tail.matrixAutoUpdate = false;
  tail.frustumCulled = false;
  scene.add(tail);
  const comaMaterial = keep(
    new SpriteMaterial({ map: glow, color: 0xcfe6ff, blending: AdditiveBlending, depthWrite: false, transparent: true }),
  );
  const coma = new Sprite(comaMaterial);
  coma.scale.setScalar(2.3);
  comet.add(coma);

  let nucleusRequested = false;
  const loadNucleus = () => {
    nucleusRequested = true;
    void Promise.all([
      import("three/examples/jsm/loaders/GLTFLoader.js"),
      loader.loadAsync(HERO_ASSETS.nucleus.map),
    ])
      .then(async ([{ GLTFLoader }, map]) => {
        const gltf = await new GLTFLoader().loadAsync(HERO_ASSETS.nucleus.model);
        if (disposed) return void map.dispose();
        const material = keep(new MeshStandardMaterial({ roughness: 1, metalness: 0 }));
        map.flipY = false; // glTF texture space
        setMap(material, 0, map);
        gltf.scene.traverse((node) => {
          const mesh = node as Mesh;
          if (!mesh.isMesh) return;
          keep(mesh.geometry);
          mesh.material = material;
        });
        // NASA's model is in metres, about 280 from the centre to the surface.
        gltf.scene.scale.setScalar(0.5 / 280);
        gltf.scene.name = "nucleus";
        comet.add(gltf.scene);
      })
      // Without the model the coma and tail still read as a comet.
      .catch(() => {});
  };

  // --- Frame.
  const size = { w: 1, h: 1 };
  let layout: Layout = opts.layout ?? "stacked";
  const measure = () => {
    size.w = host.clientWidth || 1;
    size.h = host.clientHeight || 1;
    if (!opts.layout) layout = layoutFor(size.w, size.h);
    renderer.setSize(size.w, size.h, false);
    camera.aspect = size.w / size.h;
    camera.updateProjectionMatrix();
    // Point sizes are in device pixels; a tall frame also shows more sky per pixel.
    starMaterial.uniforms.uScale.value = renderer.getPixelRatio() * Math.min(1.4, Math.max(0.85, size.h / 900));
  };

  const projected = new Vector3();
  const place = (el: HTMLElement | null, x: number, y: number, z: number) => {
    if (!el) return;
    projected.set(x, y, z).project(camera);
    const px = (projected.x * 0.5 + 0.5) * size.w;
    const py = (-projected.y * 0.5 + 0.5) * size.h;
    el.style.transform = `translate3d(${px.toFixed(1)}px,${py.toFixed(1)}px,0)`;
  };

  let p = opts.fixedTime === undefined ? Math.min(1, Math.max(0, opts.progress())) : opts.progress();
  let time = opts.fixedTime ?? 0;
  let liveRadius = radiusForDays(opts.liveDays());
  const away = new Vector3();
  const toCamera = new Vector3();
  const side = new Vector3();
  const normal = new Vector3();
  const basis = new Matrix4();

  const draw = () => {
    const pose = cameraPose(p, camera.aspect, layout);
    camera.position.set(...pose.position);
    camera.lookAt(...pose.target);
    camera.updateMatrixWorld();
    fill.position.copy(camera.position);
    // Just off the star's surface on the camera's side: inside the sphere it would be hidden,
    // and with depth off it would shine through a world passing in front.
    core.position.copy(camera.position).normalize().multiplyScalar(1.3);
    starMaterial.uniforms.uTime.value = time;

    const growth = 1 + OVERHEAD_GROWTH * scrub(p, BEATS.lift);
    for (const world of worlds) {
      world.pivot.scale.setScalar(world.size * growth);
      const radius = world.live ? liveRadius : world.radius;
      const angle = world.phase + time * RING_SPEED[world.ring];
      world.pivot.position.set(radius * Math.cos(angle), 0, radius * Math.sin(angle));
      world.body.rotation.y = time * 0.08 + world.phase;
      if (world.live) place(opts.anchors.live, world.pivot.position.x, 0, world.pivot.position.z);
    }
    liveLine.scale.setScalar(liveRadius);
    sun.rotation.y = time * 0.012;

    const lit = scrub(p, BEATS.rings);
    lineMaterial.opacity = 0.16 + 0.5 * lit;
    liveLineMaterial.opacity = 0.34 * lit * (1 - scrub(p, BEATS.systemOut));
    RINGS.forEach((ring, i) => place(opts.anchors.rings[i] ?? null, 0, 0, -ring.side * ring.r));

    const { position, presence } = cometAt(p);
    comet.visible = presence > 0.001;
    tailMaterial.uniforms.uStrength.value = presence * 0.85;
    comaMaterial.opacity = presence;
    if (comet.visible) {
      comet.position.set(...position);
      comet.rotation.y = time * 0.25;
      // The tail points away from the star, and turns about that axis to face the camera.
      away.copy(comet.position).normalize();
      toCamera.copy(camera.position).sub(comet.position).normalize();
      side.crossVectors(away, toCamera).normalize();
      normal.crossVectors(away, side);
      basis.makeBasis(away.multiplyScalar(TAIL_LENGTH), side.multiplyScalar(TAIL_WIDTH), normal);
      basis.setPosition(comet.position);
      tail.matrix.copy(basis);
      tail.matrixWorldNeedsUpdate = true;
    }
    if (!nucleusRequested && p > BEATS.lift[1]) loadNucleus();

    renderer.render(scene, camera);
  };

  measure();
  const ro = new ResizeObserver(() => {
    measure();
    draw();
  });
  ro.observe(host);

  // --- Loop: only while on screen in a foreground tab, and never without a context.
  let raf = 0;
  let last = 0;
  let lost = false;
  let inView = true;
  let ready = false;
  let frames = 0;
  let slowest = 0;
  const tick = (now: number) => {
    const dt = last ? Math.min((now - last) / 1000, 0.05) : 0;
    last = now;
    if (opts.fixedTime === undefined) {
      time += dt;
      p += (Math.min(1, Math.max(0, opts.progress())) - p) * Math.min(1, dt * 10);
      liveRadius += (radiusForDays(opts.liveDays()) - liveRadius) * Math.min(1, dt * 5);
      // One step down if the first second runs slow: sharpness is worth less than motion.
      if (frames < 60 && dt > 0) {
        slowest += dt;
        if (++frames === 60 && slowest / 60 > 0.04 && renderer.getPixelRatio() > 1) {
          renderer.setPixelRatio(1);
          measure();
        }
      }
    } else {
      p = opts.progress();
      liveRadius = radiusForDays(opts.liveDays());
    }
    draw();
    raf = requestAnimationFrame(tick);
  };
  const sync = () => {
    cancelAnimationFrame(raf);
    last = 0;
    if (ready && !lost && !document.hidden && inView) raf = requestAnimationFrame(tick);
  };
  const io = new IntersectionObserver((entries) => {
    inView = entries[0]?.isIntersecting ?? true;
    sync();
  });
  io.observe(host);
  document.addEventListener("visibilitychange", sync);

  const onLost = (event: Event) => {
    event.preventDefault(); // or the browser never restores it
    lost = true;
    sync();
    opts.onLost(true);
  };
  const onRestored = () => {
    lost = false;
    sync();
    opts.onLost(false);
  };
  canvas.addEventListener("webglcontextlost", onLost);
  canvas.addEventListener("webglcontextrestored", onRestored);

  // The first frame waits for every coarse map, so the canvas never fades in half-dressed.
  // If any of them fails the poster simply stays.
  void Promise.all(first)
    .then(() => {
      if (disposed) return;
      ready = true;
      draw();
      opts.onReady();
      sync();
      if (!opts.light) for (const load of sharpen) load();
    })
    .catch(() => {});

  return () => {
    disposed = true;
    cancelAnimationFrame(raf);
    document.removeEventListener("visibilitychange", sync);
    io.disconnect();
    ro.disconnect();
    // Before the forced loss below, or cleanup would report a lost context to the page.
    canvas.removeEventListener("webglcontextlost", onLost);
    canvas.removeEventListener("webglcontextrestored", onRestored);
    for (const material of ranks.keys()) (material as MeshBasicMaterial).map?.dispose();
    for (const thing of disposables) thing.dispose();
    renderer.dispose();
    // Browsers cap live WebGL contexts; a leaked one means a later visit renders nothing.
    renderer.forceContextLoss();
    canvas.remove();
  };
}
