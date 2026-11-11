/**
 * Generated planets: one per member, drawn from a key, never stored.
 *
 * WHY THIS EXISTS. Nothing records which planet someone saw, so the generator must be a
 * pure function: the same key has to draw the same bytes forever, or every member's planet
 * silently changes on the next deploy. It must also stay Satori-safe (no filters), or the
 * card's link preview renders blank. And it must nest inside the card's own SVG without
 * clashing ids.
 *
 * Run: npx tsx scripts/smoke-planet-generate.ts
 */
import { checker } from "./smoke/check";
import { generatePlanet, isPlanetKey, planetKey, planetName, randomPlanetKey } from "../src/lib/planets/generate";

const t = checker();

async function main() {
  const key = planetKey("3f0c8a52-0000-4000-8000-000000000001");
  t.check("key is 16 hex chars", isPlanetKey(key), key);
  t.check("key does not echo the id", !key.includes("3f0c8a52"));

  const a = generatePlanet(key);
  t.check("same key draws identical SVG", a.svg === generatePlanet(key).svg);
  // Pinned so a refactor that shifts the RNG sequence (which would re-draw every member's
  // planet) fails here instead of shipping. Re-pin only on purpose, before anyone has one.
  t.check("drawing is pinned", a.kind === "banded" && a.svg.length === 6035, `${a.kind} ${a.svg.length}`);

  const seen = new Set<string>();
  const kinds = new Map<string, number>();
  let ringed = 0;
  let unsafe = 0;
  let largest = 0;
  const N = 10_000;
  for (let i = 0; i < N; i++) {
    const p = generatePlanet(planetKey(`member-${i}`));
    seen.add(p.svg);
    kinds.set(p.kind, (kinds.get(p.kind) ?? 0) + 1);
    if (p.ringed) ringed++;
    if (/<filter|feGaussianBlur|<mask|<pattern|<text/.test(p.svg)) unsafe++;
    largest = Math.max(largest, p.svg.length);
  }
  t.check("10k keys draw 10k different planets", seen.size === N, String(seen.size));
  t.check("every kind shows up", kinds.size === 4, JSON.stringify([...kinds]));
  t.check("rings and moons stay a minority", ringed > N * 0.1 && ringed < N * 0.3, String(ringed));
  t.check("only Satori-safe elements", unsafe === 0, String(unsafe));
  t.check("SVG stays small", largest < 16_000, String(largest));

  const fresh = randomPlanetKey();
  t.check("random keys are keys", isPlanetKey(fresh), fresh);
  t.check("random keys differ", randomPlanetKey() !== randomPlanetKey());
  t.check("a planet carries its name", generatePlanet(fresh).name === planetName(fresh));
  const nested = generatePlanet(key, "card9-pl");
  t.check("nestable body uses the id prefix", nested.body.includes('id="card9-plc"') && !nested.body.includes('id="pc"') && !nested.body.startsWith("<svg"));
  t.check("same drawing whatever the prefix", nested.body.replaceAll("card9-pl", "p") === a.body);
  t.check("names are stable", planetName(key) === planetName(key));
  const names = new Set<string>();
  let badName = 0;
  for (let i = 0; i < N; i++) {
    const n = planetName(planetKey(`member-${i}`));
    names.add(n);
    if (!/^[A-Z][a-z]{4,9}$/.test(n) || /mercury|venus|earth|mars|jupiter|saturn|uranus|neptune|fuck|shit|sex/i.test(n)) badName++;
  }
  t.check("names are 5-10 letters, capitalised, clean", badName === 0, String(badName));
  t.check("names vary (most of 10k distinct)", names.size > N * 0.5, String(names.size));

  t.done("planet generator");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
