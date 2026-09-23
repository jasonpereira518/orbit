/**
 * The swarm's maths, with no canvas in sight: how many dots a crowd becomes, where they sit,
 * and how they settle. 3,000 people must not mean 3,000 particles.
 *
 * Run: npx tsx scripts/smoke-finish-scene-geometry.ts
 */
import {
  FACE_RADIUS,
  MAX_DOTS,
  MAX_FACES,
  SCENE_HEIGHT,
  dotCount,
  layoutDots,
  settle,
} from "../src/lib/imports/finish-scene-geometry";

let failures = 0;
function check(label: string, ok: boolean, detail?: string) {
  if (ok) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.error(`  FAIL ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

check("a small import is one dot each", dotCount(12) === 12);
check("an empty import draws nothing", dotCount(0) === 0);
check("a huge import is capped", dotCount(3000) === MAX_DOTS);
check("…and the cap is the cap", dotCount(MAX_DOTS + 1) === MAX_DOTS);

const dots = layoutDots(3000, 600, 180);
check("lays out exactly the capped count", dots.length === MAX_DOTS);
check("no more faces than the cap", dots.filter((d) => d.face).length <= MAX_FACES);
check("faces are the ones that arrive first", dots.filter((d) => d.face).every((d) => d.delay <= Math.max(...dots.map((x) => x.delay)) / 2));
check("every dot sits inside the canvas", dots.every((d) => d.radiusX > 0 && d.radiusX <= 300 && d.radiusY > 0 && d.radiusY <= 90));
check("rings are used, not one circle", new Set(dots.map((d) => d.ring)).size > 1);
check("angles stay in one turn", dots.every((d) => d.angle >= 0 && d.angle < Math.PI * 2));
check("delays are staggered", new Set(dots.map((d) => d.delay)).size > 1);

const small = layoutDots(3, 600, 180);
check("three people are three dots", small.length === 3);
check("…and all three get faces", small.every((d) => d.face));

check("settle starts at the start", settle(0) === 0);
check("settle ends at the end", settle(1) === 1);
check("settle is monotonic", [0.1, 0.3, 0.5, 0.7, 0.9].every((t, i, a) => i === 0 || settle(t) > settle(a[i - 1])));
check("settle eases out, not linear", settle(0.5) > 0.5);

const phone = layoutDots(3000, 340, SCENE_HEIGHT.phone);
check("a phone canvas keeps dots inside it", phone.every((d) => d.radiusX <= 170 && d.radiusY <= 60));

/**
 * A face is a circle, not a point.
 *
 * The dot's position is its centre, and a face draws a FACE_RADIUS circle (plus a one-pixel
 * ring) around it — so a centre that fits can still put half the photo off the canvas. At a
 * phone's 120px the outer ring's centre sat at 51.6 of a 60px half-height and the face ran
 * past the bottom edge. Small runs are where it shows: with few people, faces spread across
 * all three rings instead of filling the inner one.
 */
const fits = (dots: ReturnType<typeof layoutDots>, width: number, height: number) =>
  dots
    .filter((d) => d.face)
    .every(
      (d) =>
        d.radiusX + FACE_RADIUS + 1 <= width / 2 &&
        d.radiusY + FACE_RADIUS + 1 <= height / 2,
    );
for (const people of [3, 5, 12, 40, 3000]) {
  check(
    `${people} people: every face fits a 340×${SCENE_HEIGHT.phone} phone canvas`,
    fits(layoutDots(people, 340, SCENE_HEIGHT.phone), 340, SCENE_HEIGHT.phone),
  );
  check(
    `${people} people: every face fits a 600×${SCENE_HEIGHT.desktop} desktop canvas`,
    fits(layoutDots(people, 600, SCENE_HEIGHT.desktop), 600, SCENE_HEIGHT.desktop),
  );
}
check(
  "…and the faces still use more than one ring",
  new Set(layoutDots(12, 340, SCENE_HEIGHT.phone).filter((d) => d.face).map((d) => d.radiusY)).size > 1,
);

if (failures) {
  console.error(`smoke-finish-scene-geometry: ${failures} failed`);
  process.exit(1);
}
console.log("smoke-finish-scene-geometry: all checks passed");
process.exit(0);
