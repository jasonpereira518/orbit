/**
 * The landing hero, checked where no GPU is needed.
 *
 * The scene itself can only be judged by eye, but four things about it are arithmetic or
 * bookkeeping, and each has a way of going wrong that the page would hide:
 *
 * 1. The slider's rule is the product's rule. The hero tells a visitor someone has "gone
 *    quiet" after 30 days and is a "comet" after a year. Those are the app's thresholds; if
 *    the app moves one, the page must not keep saying the old number.
 * 2. The system fits the frame, at every size, in the layout that frame gets. A ring that
 *    runs under the claim, or off a phone's edge, is a framing bug no type check sees.
 * 3. The scene stays out of the first load. One value import of hero-scene.ts from the pin
 *    puts three in the landing page's entry bundle.
 * 4. Every file the page serves that Orbit did not make has a credit, and the comet's model
 *    asks the loader for nothing the production CSP refuses (no embedded image, no
 *    extension).
 *
 * Run: npx tsx scripts/smoke-landing-hero.ts
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  COMET_DAYS,
  HERO_ASSETS,
  LAST_TALKED_STOPS,
  QUIET_DAYS,
  RINGS,
  WORLDS,
  layoutFor,
  projectToFrame,
  radiusForDays,
  ringForDays,
} from "../src/components/landing/hero-choreography";
import { LANDING_CREDITS } from "../src/components/landing/landing-credits";
import { COMET_DORMANT_DAYS } from "../src/lib/comet";
import { DORMANT_DAYS } from "../src/lib/outreach-thresholds";

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`  ${ok ? "ok  " : "FAIL"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

function main() {
  console.log("The slider's rule is the product's rule:");
  check("quiet after the app's DORMANT_DAYS", QUIET_DAYS === DORMANT_DAYS, `${QUIET_DAYS} vs ${DORMANT_DAYS}`);
  check("a comet after the app's COMET_DORMANT_DAYS", COMET_DAYS === COMET_DORMANT_DAYS, `${COMET_DAYS} vs ${COMET_DORMANT_DAYS}`);
  check(
    "the ring changes exactly at each threshold",
    ringForDays(QUIET_DAYS - 1) === 0 && ringForDays(QUIET_DAYS) === 1 && ringForDays(COMET_DAYS - 1) === 1 && ringForDays(COMET_DAYS) === 2,
  );
  const radii = LAST_TALKED_STOPS.map((stop) => radiusForDays(stop.days));
  check("a longer silence never moves a world inward", radii.every((r, i) => i === 0 || r >= radii[i - 1]));
  // A ring's label states its threshold ("30 days without contact"), so a world must be ON
  // the ring at that threshold, not between two of them.
  const on = (days: number, ring: number) => Math.abs(radiusForDays(days) - RINGS[ring].r) < 1e-9;
  check("a world talked to today is on the first ring", on(0, 0));
  check("a world reaches the quiet ring at exactly the quiet threshold", on(QUIET_DAYS, 1));
  check("a world reaches the comet ring at exactly the comet threshold", on(COMET_DAYS, 2));
  check(
    "past the last threshold a world stays within the frame's margin",
    radiusForDays(LAST_TALKED_STOPS[LAST_TALKED_STOPS.length - 1].days) <= RINGS[2].r * 1.1,
  );
  check("the slider reaches every ring", new Set(LAST_TALKED_STOPS.map((stop) => ringForDays(stop.days))).size === RINGS.length);

  console.log("\nThe system fits the frame it is laid out for:");
  const outer = RINGS[RINGS.length - 1].r;
  const OVERHEAD = 0.5;
  for (const [w, h] of [[360, 640], [390, 844], [768, 1024], [1024, 768], [1280, 720], [1440, 900], [1920, 1080], [2560, 1440], [3840, 2160]]) {
    const aspect = w / h;
    const layout = layoutFor(w, h);
    const split = layout === "split";
    const at = (x: number, z: number) => projectToFrame(OVERHEAD, aspect, [x, 0, z], layout);
    const left = at(-outer, 0).x;
    const right = at(outer, 0).x;
    const top = at(0, -outer).y;
    const bottom = at(0, outer).y;
    const span = `x ${left.toFixed(2)}–${right.toFixed(2)}, y ${top.toFixed(2)}–${bottom.toFixed(2)}`;
    if (split) {
      // Side by side: the left two fifths are the claim's and the slider's.
      check(`${w}×${h} side by side: the outer ring keeps to the right`, left >= 0.4 && right <= 0.98 && top >= 0.08 && bottom <= 0.97, span);
    } else {
      // Stacked: the claim has the top quarter, the slider the bottom fifth.
      check(`${w}×${h} stacked: the outer ring sits between claim and slider`, left >= 0.02 && right <= 0.98 && top >= 0.26 && bottom <= 0.82, span);
    }
    const star = projectToFrame(0, aspect, [0, 0, 0], layout);
    check(`${w}×${h} hero: the star is in frame, right of centre or above it`, star.x > 0.3 && star.x < 1 && star.y > 0 && star.y < 0.7, `${star.x.toFixed(2)}, ${star.y.toFixed(2)}`);
  }

  console.log("\nThe scene stays out of the first load:");
  const pin = readFileSync("src/components/landing/hero-pin.tsx", "utf8");
  const staticImports = [...pin.matchAll(/^import\s+(type\s+)?[^;]*?from\s+"([^"]+)";/gm)];
  const sceneImports = staticImports.filter((m) => m[2].endsWith("/hero-scene"));
  check("hero-pin.tsx has no value import of hero-scene", sceneImports.every((m) => Boolean(m[1])), sceneImports.map((m) => m[0]).join(" "));
  check("hero-pin.tsx loads the scene with import()", /import\("@\/components\/landing\/hero-scene"\)/.test(pin));
  const choreography = readFileSync("src/components/landing/hero-choreography.ts", "utf8");
  check("hero-choreography.ts does not import three", !/from\s+"three/.test(choreography));

  console.log("\nEvery served file exists, and is credited or Orbit's own:");
  const served = (url: string) => join("public", url);
  const urls = [
    ...Object.values(HERO_ASSETS.sun),
    ...Object.values(HERO_ASSETS.milkyWay),
    ...WORLDS.flatMap((world) => Object.values(HERO_ASSETS.world(world.id))),
    HERO_ASSETS.saturnRing,
    HERO_ASSETS.nucleus.model,
    HERO_ASSETS.nucleus.map,
  ];
  const missing = urls.filter((url) => !existsSync(served(url)));
  check(`all ${urls.length} hero assets are in public/`, missing.length === 0, missing.join(", "));
  /** Made here: the hero's posters are stills of Orbit's own scene. */
  const OWN = ["hero/poster-"];
  const credited = LANDING_CREDITS.flatMap((credit) => credit.files);
  const uncredited: string[] = [];
  for (const dir of ["hero", "photos", "video"]) {
    for (const file of readdirSync(join("public", "landing", dir))) {
      const key = `${dir}/${file}`;
      if (![...credited, ...OWN].some((prefix) => key.startsWith(prefix))) uncredited.push(key);
    }
  }
  check("no file under public/landing/{hero,photos,video} lacks a credit", uncredited.length === 0, uncredited.join(", "));
  const unused = credited.filter((prefix) => {
    const [dir, stem] = prefix.split("/");
    return !readdirSync(join("public", "landing", dir)).some((file) => file.startsWith(stem));
  });
  check("no credit names a file that is not served", unused.length === 0, unused.join(", "));

  console.log("\nThe comet's model asks the loader for nothing the CSP refuses:");
  const glbPath = served(HERO_ASSETS.nucleus.model);
  if (existsSync(glbPath)) {
    const glb = readFileSync(glbPath);
    const json = JSON.parse(glb.subarray(20, 20 + glb.readUInt32LE(12)).toString("utf8"));
    check("it is a glTF 2 binary", glb.toString("latin1", 0, 4) === "glTF" && glb.readUInt32LE(4) === 2);
    check("it is at most 1 MB", statSync(glbPath).size <= 1024 * 1024, `${statSync(glbPath).size} bytes`);
    check("it embeds no image (those load through a blob: fetch)", !json.images && !json.textures);
    check("it uses no extension (Draco, meshopt and KTX2 need wasm)", !json.extensionsUsed && !json.extensionsRequired);
    check("it declares the bytes it carries", json.buffers.length === 1 && glb.length === glb.readUInt32LE(8));
  }

  if (failures > 0) {
    console.error(`\nFAILED: ${failures} check(s).`);
    process.exit(1);
  }
  console.log("\nThe hero's rule, framing, loading and assets hold.");
  process.exit(0);
}

main();
