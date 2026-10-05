/**
 * One planet per review card, in solar-system order, with art or a palette for every id.
 * Run: npx tsx scripts/smoke-capture-planets.ts
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { PLANETS, PLANET_ORDER, PLANET_RINGS, planetForCloseness, planetForIndex } from "../src/lib/capture/planets";

function check(label: string, condition: boolean, detail?: string) {
  if (!condition) throw new Error(`${label} failed${detail ? `: ${detail}` : ""}`);
  console.log(`  ok  ${label}`);
}

check("the eight planets come first, in order", PLANET_ORDER.slice(0, 8).join() === "mercury,venus,earth,mars,jupiter,saturn,uranus,neptune");
check("then dwarf planets, then moons", PLANET_ORDER.slice(8).join() === "pluto,ceres,eris,moon,titan,europa,ganymede");
check("fifteen bodies", PLANET_ORDER.length === 15);
check("every id has a definition", PLANET_ORDER.every((id) => PLANETS[id]?.id === id));
check("every raster body has its art in all three formats", PLANET_ORDER.filter((id) => PLANETS[id].kind === "raster").every((id) =>
  ["avif", "webp", "png"].every((ext) => existsSync(join(process.cwd(), "public", "landing", "planets", `${id}.${ext}`)))
));
check("every body has a glow and three stops", PLANET_ORDER.every((id) => PLANETS[id].glow.startsWith("rgba(") && PLANETS[id].stops.length === 3));
check("card 1 is Mercury", planetForIndex(0).id === "mercury");
check("card 9 is Pluto", planetForIndex(8).id === "pluto");
check("card 16 wraps to Mercury", planetForIndex(15).id === "mercury");
check("a negative index does not throw", planetForIndex(-1).id === "ganymede");
check("Saturn and Uranus carry rings", PLANETS.saturn.rings === true && PLANETS.uranus.rings === true && !PLANETS.earth.rings);

console.log("\nsmoke-capture-planets: all checks passed");

// Planet = orbit ring: closeness picks the ring, the card's position picks the body in it.
{
  const all = Object.values(PLANET_RINGS).flat();
  check("every ring body is a defined planet", all.every((id) => PLANETS[id]?.id === id));
  check("no body sits on two rings", new Set(all).size === all.length);
  check("closest people get Mercury", planetForCloseness(5, 0).id === "mercury");
  check("a barely-known person is out past Neptune", PLANET_RINGS[1].includes(planetForCloseness(1, 7).id));
  check("same closeness, next card → a different body", planetForCloseness(3, 0).id !== planetForCloseness(3, 1).id);
  check("changing closeness moves the planet", planetForCloseness(2, 0).id !== planetForCloseness(4, 0).id);
  check("out-of-range closeness clamps", planetForCloseness(9, 0).id === "mercury" && PLANET_RINGS[1].includes(planetForCloseness(-3, 0).id));
  console.log("\nsmoke-capture-planets: ring checks passed");
}
