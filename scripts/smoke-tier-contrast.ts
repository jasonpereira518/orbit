/**
 * Plan colors (pricing v2) keep their promises, read straight from globals.css:
 *
 *  - Free, Pro, Max and Lifetime each clear WCAG AA (4.5:1) as TEXT on every card surface of
 *    both themes (`SURFACES` in src/lib/contrast.ts).
 *  - Badge ink clears 4.5:1 on both ends of its metallic sheen.
 *  - The always-dark ("night") values clear 4.5:1 on the deep-space background.
 *  - Max is the exact gold the app used for its top tier before v2.
 *  - Pro's blue stays visibly apart from the dark theme's `--primary` (a sky cyan) — it must
 *    never read as "just the accent color".
 *
 * Pure: reads a file, no database. Run: npx tsx scripts/smoke-tier-contrast.ts
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { contrastRatio, hexToHsl, MIN_CONTRAST, worstContrast } from "../src/lib/contrast";

let failures = 0;
function check(label: string, ok: boolean, detail?: unknown) {
  if (ok) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.error(`  FAIL ${label}${detail === undefined ? "" : `\n       ${JSON.stringify(detail)}`}`);
  }
}

const css = readFileSync(join(process.cwd(), "src/app/globals.css"), "utf8");

/** The first `selector { … }` block's declarations. */
function block(selector: string): string {
  const start = css.indexOf(`${selector} {`);
  if (start < 0) throw new Error(`no ${selector} block`);
  return css.slice(start, css.indexOf("\n}", start));
}
function value(src: string, name: string): string {
  const m = src.match(new RegExp(`${name}:\\s*(#[0-9a-fA-F]{6})`));
  if (!m) throw new Error(`${name} not found`);
  return m[1].toLowerCase();
}

const light = block(":root");
const dark = block(".dark");
const theme = block("@theme inline");
const PLANS = ["free", "pro", "max", "lifetime"] as const;

console.log("Plan colors as text, both themes");
for (const plan of PLANS) {
  const l = value(light, `--tier-${plan}`);
  const d = value(dark, `--tier-${plan}`);
  check(`${plan} on light cards ≥ ${MIN_CONTRAST}:1 (${l})`, worstContrast(l, "light") >= MIN_CONTRAST, worstContrast(l, "light"));
  check(`${plan} on dark cards ≥ ${MIN_CONTRAST}:1 (${d})`, worstContrast(d, "dark") >= MIN_CONTRAST, worstContrast(d, "dark"));
}

console.log("\nBadge sheens");
for (const plan of ["orbit", "max", "lifetime"] as const) {
  const b = block(`[data-plan="${plan}"]`);
  const ink = value(b, "--tier-sheen-ink");
  for (const end of ["--tier-sheen-from", "--tier-sheen-to"]) {
    const bg = value(b, end);
    check(`${plan}: ink on ${end} ≥ ${MIN_CONTRAST}:1`, contrastRatio(ink, bg) >= MIN_CONTRAST, contrastRatio(ink, bg));
  }
}

console.log("\nThe always-dark canvases");
const NIGHT_SKY = "#03050c";
for (const plan of PLANS) {
  const v = value(theme, `--color-night-${plan}`);
  check(`night ${plan} on deep space ≥ ${MIN_CONTRAST}:1`, contrastRatio(v, NIGHT_SKY) >= MIN_CONTRAST, contrastRatio(v, NIGHT_SKY));
}

console.log("\nIdentity");
check("Max is the app's existing gold (#8a6423 light / #f2c14e dark)",
  value(light, "--tier-max") === "#8a6423" && value(dark, "--tier-max") === "#f2c14e");
check("the night gold is the same gold", value(theme, "--color-night-max") === "#f2c14e");
const pro = hexToHsl(value(dark, "--tier-pro"));
const primary = hexToHsl(value(dark, "--primary"));
check("dark Pro blue is ≥ 10° of hue from dark --primary", Math.abs(pro.h - primary.h) >= 10, { pro: pro.h, primary: primary.h });
const silver = hexToHsl(value(light, "--tier-lifetime"));
check("Lifetime is a neutral silver-gray (saturation under 20%)", silver.s < 0.2, silver);

if (failures > 0) {
  console.error(`\n${failures} tier-contrast check(s) failed`);
  process.exit(1);
}
console.log("\nAll tier-contrast checks passed.");
