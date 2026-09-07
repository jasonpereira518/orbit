/**
 * The event theming ladder, and its contrast guarantee.
 *
 * The guarantee is the point. Hosts pick colours for their own background, not Orbit's, so a
 * pale-yellow brand on a white card is unreadable through no fault of theirs. `eventThemeVars`
 * clamps whatever arrives, and this asserts that it holds across the whole hue circle in both
 * themes — not for a handful of hand-picked samples.
 *
 * The surfaces come from `src/lib/contrast.ts`, which is the same module (and the same
 * numbers) `scripts/check-interaction-contrast.mjs` uses for the interaction tokens.
 */
import {
  MIN_CONTRAST,
  SURFACES,
  clampForContrast,
  hexToHsl,
  hslToHex,
  worstContrast,
} from "../src/lib/contrast";
import { eventGradient, eventThemeVars, resolveThemeColor } from "../src/lib/events/theme";

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

function main() {
  console.log("\nthe ladder picks by trust");
  check(
    "meta beats everything",
    resolveThemeColor({ metaColor: "#7c3aed", jsonLdColor: "#00ff00", imageColor: "#ff0000", seed: "x" }).source === "meta"
  );
  check(
    "jsonld beats image",
    resolveThemeColor({ jsonLdColor: "#0ea5e9", imageColor: "#ff0000", seed: "x" }).source === "jsonld"
  );
  check("image beats hash", resolveThemeColor({ imageColor: "#ef4444", seed: "x" }).source === "image");
  check("hash is the floor", resolveThemeColor({ seed: "x" }).source === "hash");

  console.log("\nunusable declared colours fall through");
  for (const [color, why] of [
    ["#ffffff", "white"],
    ["#000000", "black"],
    ["#f8f8f8", "near-white"],
    ["#7d7d7d", "desaturated grey"],
  ] as const) {
    // A site declaring `theme-color: #ffffff` is extremely common and says nothing about the
    // event; after clamping it would be indistinguishable grey, so the hash rung is better.
    check(`${why} is not used as an accent`, resolveThemeColor({ metaColor: color, seed: "x" }).source === "hash");
  }
  check("a malformed hex falls through", resolveThemeColor({ metaColor: "purple", seed: "x" }).source === "hash");
  check("#abc shorthand is accepted", resolveThemeColor({ metaColor: "#a3c", seed: "x" }).source === "meta");

  console.log("\nthe hash rung is deterministic and never null");
  const a = resolveThemeColor({ seed: "lu.ma" });
  const b = resolveThemeColor({ seed: "lu.ma" });
  check("same seed, same colour", a.color === b.color, `${a.color} / ${b.color}`);
  check("different seeds differ", resolveThemeColor({ seed: "eventbrite.com" }).color !== a.color);
  check("always a usable hex", /^#[0-9a-f]{6}$/.test(a.color), a.color);

  console.log(`\ncontrast across the hue circle (floor ${MIN_CONTRAST}:1)`);
  let worstLight = Infinity;
  let worstDark = Infinity;
  let hueDrift = 0;
  let checked = 0;
  for (let hue = 0; hue < 360; hue += 5) {
    for (const [s, l] of [[0.95, 0.5], [0.6, 0.75], [0.35, 0.25], [0.8, 0.9]] as const) {
      const base = hslToHex({ h: hue, s, l });
      const vars = eventThemeVars(base);
      const light = worstContrast(vars["--event-accent-light"], "light");
      const dark = worstContrast(vars["--event-accent-dark"], "dark");
      worstLight = Math.min(worstLight, light);
      worstDark = Math.min(worstDark, dark);
      // Hue is held so the event still reads as its own colour after clamping.
      const drift = Math.abs(hexToHsl(vars["--event-accent-light"]).h - hue);
      hueDrift = Math.max(hueDrift, Math.min(drift, 360 - drift));
      checked++;
    }
  }
  check(
    `every light accent clears the floor (${checked} colours)`,
    worstLight >= MIN_CONTRAST,
    `worst ${worstLight.toFixed(2)}:1`
  );
  check(
    "every dark accent clears the floor",
    worstDark >= MIN_CONTRAST,
    `worst ${worstDark.toFixed(2)}:1`
  );
  check("hue is preserved through the clamp", hueDrift < 2, `max drift ${hueDrift.toFixed(1)}°`);

  console.log("\nthe clamp is checked against BOTH surfaces per theme");
  for (const theme of ["light", "dark"] as const) {
    const clamped = clampForContrast("#ffff00", theme);
    const each = SURFACES[theme].map((bg) => worstContrast(clamped, theme) >= MIN_CONTRAST && bg);
    check(`${theme}: card and background both clear`, each.every(Boolean), SURFACES[theme].join(" / "));
  }

  console.log("\nvariables and gradient");
  {
    const vars = eventThemeVars("#7c3aed");
    const keys = Object.keys(vars);
    check("both themes ship inline", keys.length === 6 && keys.every((k) => k.endsWith("-light") || k.endsWith("-dark")), keys.join(","));
    check("every value is a hex", Object.values(vars).every((v) => /^#[0-9a-f]{6}$/.test(v)));
    // A low alpha of a saturated hue "reads burnt"; the tint is a mix toward the ground.
    check("the light tint is pale", hexToHsl(vars["--event-tint-light"]).l > 0.9);
    check("the dark tint is deep", hexToHsl(vars["--event-tint-dark"]).l < 0.3);
    check("an invalid stored colour still yields vars", /^#[0-9a-f]{6}$/.test(eventThemeVars("nonsense")["--event-accent-light"]));
  }
  check("the gradient is a CSS gradient", eventGradient("#7c3aed").startsWith("linear-gradient("));

  if (failures > 0) {
    console.error(`\n${failures} check(s) failed.`);
    process.exit(1);
  }
  console.log("\nAll event theme checks passed.");
}

main();
