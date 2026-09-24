/**
 * The done card's arrival, as maths: how many bodies a crowd becomes, how they move, and what
 * the headline says while they do. No canvas.
 *
 * Every check here is a promise the approved prototype made and a later edit could quietly
 * break: nobody moves backward, nobody speeds up again after swinging past the planet, the
 * count ends exactly on the real number, and everything stays on the canvas at phone and
 * desktop sizes.
 *
 * Run: npx tsx scripts/smoke-finish-scene-geometry.ts
 */
import {
  BREATH,
  MAX_DOTS,
  MAX_FACES,
  SCENE_HEIGHT,
  TILT,
  bodiesFor,
  breathAt,
  buildScene,
  countAt,
  depthScale,
  DOT_RADIUS,
  PHOTO_REVEAL_SECONDS,
  photoReveal,
  poseAt,
  type Scene,
  type SceneBody,
} from "../src/lib/imports/finish-scene-geometry";

let failures = 0;
function check(label: string, ok: boolean, detail?: string) {
  if (ok) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.error(`  FAIL ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

const SIZES = [
  { label: "desktop", width: 600, height: SCENE_HEIGHT.desktop },
  { label: "phone", width: 303, height: SCENE_HEIGHT.phone },
];
const CROWDS = [1, 5, 12, 45, 300, 3000];

console.log("A crowd becomes a bounded number of bodies");
check("3,000 people is capped", bodiesFor(3000).faces === MAX_FACES && bodiesFor(3000).dots === MAX_DOTS);
check("12 people are all faces", bodiesFor(12).faces === 12 && bodiesFor(12).dots === 0);
check("one person is one face", bodiesFor(1).faces === 1 && bodiesFor(1).dots === 0);
check("nobody is nothing", bodiesFor(0).faces === 0 && bodiesFor(0).dots === 0);

/** The angle round the planet a pose sits at, undoing the tilt. */
const angleOf = (scene: Scene, x: number, y: number) =>
  Math.atan2((y - scene.cy) / TILT, x - scene.cx);

/** Angular positions sampled every `step` seconds, unwrapped so a lap does not read as a jump. */
function unwrapped(scene: Scene, body: SceneBody, from: number, to: number, step: number) {
  const out: number[] = [];
  let prev: number | null = null;
  let offset = 0;
  for (let t = from; t <= to; t += step) {
    const p = poseAt(scene, body, t);
    const a = angleOf(scene, p.x, p.y);
    if (prev !== null) {
      if (a - prev < -Math.PI) offset += Math.PI * 2;
      else if (a - prev > Math.PI) offset -= Math.PI * 2;
    }
    out.push(a + offset);
    prev = a;
  }
  return out;
}

for (const size of SIZES) {
  for (const people of CROWDS) {
    const scene = buildScene(people, size.width, size.height);
    const tag = `${people} on ${size.label}`;

    check(`${tag}: the arrival ends inside 6 seconds`, scene.duration > 1.5 && scene.duration < 6, `${scene.duration.toFixed(2)}s`);

    // The count: nothing before the first settle, never down, exactly right at the end.
    const counts: number[] = [];
    for (let t = 0; t <= scene.duration + 0.01; t += 0.02) counts.push(countAt(scene, t));
    check(`${tag}: the count starts at 0`, countAt(scene, 0) === 0);
    check(`${tag}: the count never goes down`, counts.every((c, i) => i === 0 || c >= counts[i - 1]));
    check(`${tag}: the count ends on the real number`, countAt(scene, scene.duration) === people, String(countAt(scene, scene.duration)));

    // Forward only, and one speed-up. After the closest pass each body's angular speed may only
    // fall, from the pass to its ring's resting speed.
    const STEP = 1 / 120;
    let backward = 0;
    let reaccelerated = 0;
    for (const body of scene.bodies) {
      const path = unwrapped(scene, body, body.start + 0.2, scene.duration + 2, STEP);
      if (path.some((a, i) => i > 0 && a < path[i - 1] - 1e-6)) backward++;
      const after = unwrapped(scene, body, body.pass, body.settleAt + 1, STEP);
      const speeds = after.slice(1).map((a, i) => (a - after[i]) / STEP);
      // A little slack for the angle being recovered from pixels, not read off the maths.
      if (speeds.some((v, i) => i > 0 && v > speeds[i - 1] + 0.05)) reaccelerated++;
    }
    check(`${tag}: nobody moves backward`, backward === 0, `${backward} did`);
    check(`${tag}: nobody speeds up again after the pass`, reaccelerated === 0, `${reaccelerated} did`);

    // Settled, everyone is on the canvas, and no two share a place.
    const late = scene.duration + 30;
    const offCanvas = scene.bodies.filter((body) => {
      const p = poseAt(scene, body, late);
      const r = (body.faceIndex >= 0 ? scene.faceRadius : DOT_RADIUS) * depthScale(p.depth) + 1;
      return p.x - r < 0 || p.x + r > size.width || p.y - r < 0 || p.y + r > size.height;
    });
    check(`${tag}: every settled body is on the canvas`, offCanvas.length === 0, `${offCanvas.length} off`);
    const places = new Set(
      scene.bodies.map((body) => {
        const p = poseAt(scene, body, late);
        return `${Math.round(p.x)},${Math.round(p.y)}`;
      }),
    );
    check(`${tag}: no two settle in the same place`, places.size === scene.bodies.length);
    check(
      `${tag}: depth stays between back and front`,
      scene.bodies.every((b) => {
        const d = poseAt(scene, b, late).depth;
        return d >= 0 && d <= 1;
      }),
    );
  }
}

console.log("It falls in from the top left");
{
  const scene = buildScene(45, 600, SCENE_HEIGHT.desktop);
  const first = scene.bodies[0];
  const start = poseAt(scene, first, first.start);
  check("the first body starts off the canvas, above and to the left", start.x < 0 && start.y < 0, `${start.x.toFixed(0)},${start.y.toFixed(0)}`);
}

console.log("The same scene every time");
{
  const a = buildScene(45, 600, SCENE_HEIGHT.desktop);
  const b = buildScene(45, 600, SCENE_HEIGHT.desktop);
  check(
    "two builds of the same crowd are identical",
    JSON.stringify(a) === JSON.stringify(b),
  );
}

console.log("A face turns into its photo once it has settled and the photo is in");
check("no photo, no turning", photoReveal(10, 2, null) === 0);
check("not before it settles, however early the photo came", photoReveal(1.9, 2, 0.5) === 0);
check("halfway through, half turned", Math.abs(photoReveal(2 + PHOTO_REVEAL_SECONDS / 2, 2, 0.5) - 0.5) < 1e-9);
check("done once the turn has run", photoReveal(2 + PHOTO_REVEAL_SECONDS, 2, 0.5) === 1);
check("a photo that arrives late turns from when it arrives", photoReveal(5.1, 2, 5) > 0 && photoReveal(5.1, 2, 5) < 1);
check("…and waits for it", photoReveal(4.9, 2, 5) === 0);

console.log("The planet breathes, slightly");
{
  const samples = Array.from({ length: 200 }, (_, i) => breathAt(i * 0.05));
  check("never past its amplitude", samples.every((s) => Math.abs(s - 1) <= BREATH.amplitude + 1e-9));
  check("it does actually move", Math.max(...samples) - Math.min(...samples) > BREATH.amplitude);
  check("it starts at its own size", breathAt(0) === 1);
}

if (failures) {
  console.error(`smoke-finish-scene-geometry: ${failures} failed`);
  process.exit(1);
}
console.log("smoke-finish-scene-geometry: all checks passed");
process.exit(0);
