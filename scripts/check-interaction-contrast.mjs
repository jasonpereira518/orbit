/**
 * Gate on the interaction-family tokens read straight out of `globals.css`.
 *
 * Colour is the whole point of these four tokens, and the two properties that make them work
 * are not visible by eye: 4.5:1 against the surface each actually sits on, and a lightness
 * ladder that runs monotonically with presence in both themes. The ladder is what keeps
 * `together` (gold) and `live` (rose) apart under deuteranopia, where those hues converge.
 *
 * Run: node scripts/check-interaction-contrast.mjs
 */
import { readFileSync } from "node:fs";

const css = readFileSync("src/app/globals.css", "utf8");

const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
const channel = (c) => (c /= 255) <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
const luminance = (h) => {
  const [r, g, b] = hex(h);
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
};
const contrast = (a, b) => {
  const x = luminance(a), y = luminance(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
};
const lstar = (h) => {
  const y = luminance(h);
  return y <= 216 / 24389 ? y * (24389 / 27) : Math.cbrt(y) * 116 - 16;
};

const FAMILIES = ["together", "live", "written", "yours"];
/** Card and page ground, per theme — the two surfaces a node or a chip is ever drawn on. */
const SURFACES = { light: ["#ffffff", "#fbfbf9"], dark: ["#1a2438", "#212c42"] };
const MIN_CONTRAST = 4.5;

const found = [...css.matchAll(/--interaction-(together|live|written|yours):\s*(#[0-9a-f]{6})/gi)];
const problems = [];

if (found.length !== 8) {
  problems.push(`expected 8 declarations (4 families x 2 themes), found ${found.length}`);
}

const themes = { light: found.slice(0, 4), dark: found.slice(4) };

for (const [theme, entries] of Object.entries(themes)) {
  const names = entries.map(([, name]) => name.toLowerCase());
  if (names.join(",") !== FAMILIES.join(",")) {
    problems.push(`${theme}: families are declared as ${names.join(", ")} — expected ${FAMILIES.join(", ")} in presence order`);
    continue;
  }

  const ladder = [];
  for (const [, name, value] of entries) {
    const ratios = SURFACES[theme].map((bg) => contrast(value, bg));
    const worst = Math.min(...ratios);
    if (worst < MIN_CONTRAST) {
      problems.push(`${theme} ${name} ${value}: ${worst.toFixed(2)}:1 against ${SURFACES[theme][ratios.indexOf(worst)]} — below ${MIN_CONTRAST}:1`);
    }
    ladder.push(lstar(value));
    console.log(`  ${theme.padEnd(5)} ${name.padEnd(9)} ${value}  ${ratios.map((r) => r.toFixed(2)).join(" / ")}   L*=${lstar(value).toFixed(1)}`);
  }

  // Light gets lighter as presence drops; dark gets dimmer.
  const ordered = theme === "light" ? ladder : [...ladder].reverse();
  const monotonic = ordered.every((v, i) => i === 0 || v > ordered[i - 1]);
  if (!monotonic) {
    problems.push(`${theme}: the L* ladder is not monotonic (${ladder.map((v) => v.toFixed(1)).join(", ")}) — the families stop being separable in greyscale`);
  }
}

if (problems.length > 0) {
  console.error("\ninteraction-contrast: FAILED");
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}

console.log("\ninteraction-contrast: all four families clear 4.5:1 on both surfaces, ladder monotonic in both themes");
