/**
 * The landing page's scroll geometry, pinned where no browser is needed.
 *
 * 1. A fragment link (/#how, /#features, a shared URL) must land BELOW the fixed header.
 *    The section nav subtracts LANDING_HEADER_SCROLL_OFFSET in JS, but a typed or shared
 *    link only has CSS scroll-margin to go on, and that rule used to target ids that never
 *    existed, so every heading landed under the header.
 * 2. The page must end at its footer. The footer's glow is a circle far taller than the
 *    footer, centered on it; without vertical clipping it hung below the page and added an
 *    empty band after the footer on short phones.
 */
import { readFileSync } from "node:fs";
import {
  LANDING_HEADER_SCROLL_OFFSET,
  LANDING_SECTIONS,
} from "../src/components/landing/landing-sections";

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`  ${ok ? "ok  " : "FAIL"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

function main() {
  const css = readFileSync("src/app/globals.css", "utf8").replace(/\/\*[\s\S]*?\*\//g, " ");
  // Innermost rules only, as { selectors, body }: rules nested in @media still match.
  const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({
    selectors: m[1].split(",").map((sel) => sel.trim()),
    body: m[2],
  }));
  const marginRules = rules.filter((r) => /scroll-margin-top\s*:/.test(r.body));

  console.log("Fragment links clear the fixed header:");
  for (const { id } of LANDING_SECTIONS) {
    const rule = marginRules.find((r) => r.selectors.includes(`#${id}`));
    const rem = rule ? /scroll-margin-top\s*:\s*([\d.]+)rem/.exec(rule.body)?.[1] : undefined;
    check(`#${id} has a scroll-margin-top`, Boolean(rule));
    check(
      `#${id}'s margin equals LANDING_HEADER_SCROLL_OFFSET (${LANDING_HEADER_SCROLL_OFFSET}px)`,
      rem !== undefined && Number(rem) * 16 === LANDING_HEADER_SCROLL_OFFSET,
      rem ? `${rem}rem` : "no rem value"
    );
  }
  const sectionIds = new Set<string>(LANDING_SECTIONS.map((s) => `#${s.id}`));
  const orphans = marginRules
    .flatMap((r) => r.selectors)
    .filter((sel) => /^#[\w-]+$/.test(sel) && !sectionIds.has(sel));
  check("no scroll-margin rule targets an id outside LANDING_SECTIONS", orphans.length === 0, orphans.join(", "));

  console.log("\nThe page ends at its footer:");
  const page = readFileSync("src/components/landing/landing-page.tsx", "utf8");
  const root = /className="(landing-root[^"]*)"/.exec(page)?.[1] ?? "";
  const classes = root.split(/\s+/);
  check(
    "landing-root clips overflow on both axes",
    classes.includes("overflow-clip") && !classes.includes("overflow-x-clip"),
    root || "landing-root not found"
  );

  if (failures > 0) {
    console.error(`\nFAILED: ${failures} check(s).`);
    process.exit(1);
  }
  console.log("\nFragment links clear the header, and the page ends at its footer.");
  process.exit(0);
}

main();
