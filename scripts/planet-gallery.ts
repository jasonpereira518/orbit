/**
 * A contact sheet for tuning the planet generator by eye: the eight landing planets, then
 * generated ones from random keys, at a hero size and two avatar sizes.
 *
 * Run: npx tsx scripts/planet-gallery.ts [count] > planet-gallery.html
 * Then open the file from the repo root (the reference art is linked relatively).
 */
import { WELCOME_PLANETS } from "../src/lib/welcome-planets";
import { generatePlanet, planetDataUri, planetKey } from "../src/lib/planets/generate";

const count = Number(process.argv[2]) || 48;

const tile = (src: string, label: string, ringed: boolean, glow: string) => `
  <figure>
    <div class="big" style="--glow:${glow}"><img src="${src}" style="${ringed ? "transform:scale(1.36)" : ""}"></div>
    <div class="row"><img class="small" src="${src}"><img class="tiny" src="${src}"></div>
    <figcaption>${label}</figcaption>
  </figure>`;

const refs = WELCOME_PLANETS.map((p) =>
  tile(`public/landing/planets/${p}.png`, p, p === "saturn" || p === "uranus", "transparent"),
).join("");

const generated = Array.from({ length: count }, (_, i) => {
  const planet = generatePlanet(planetKey(`member-${i}`));
  return tile(planetDataUri(planet.svg), `${planet.kind}${planet.ringed ? " · ringed" : ""}`, planet.ringed, planet.glow);
}).join("");

process.stdout.write(`<!doctype html><meta charset="utf-8"><title>Planet gallery</title>
<style>
  body { background:#05070f; color:#9aada8; font:12px system-ui; margin:24px; }
  h2 { color:#e8f3f1; font-weight:500; }
  .grid { display:grid; grid-template-columns:repeat(auto-fill, 132px); gap:20px; }
  figure { margin:0; text-align:center; }
  .big { width:96px; height:96px; margin:0 auto; position:relative; }
  .big::before { content:""; position:absolute; inset:-18%; border-radius:50%; background:radial-gradient(circle, var(--glow) 0%, transparent 62%); opacity:.35; }
  .big img { width:100%; height:100%; position:relative; }
  .row { display:flex; gap:8px; justify-content:center; align-items:center; margin-top:8px; }
  .small { width:40px; } .tiny { width:24px; }
</style>
<h2>Reference (licensed art)</h2><div class="grid">${refs}</div>
<h2>Generated</h2><div class="grid">${generated}</div>`);
