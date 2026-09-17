/**
 * Glass surfaces must declare only the standard `backdrop-filter`.
 *
 * Tailwind v4 compiles globals.css through Lightning CSS. When a rule hand-writes the
 * prefixed twin next to the standard property, the build keeps ONLY the prefixed form.
 * Chromium and Firefox ignore that, so the blur silently dies while every other declaration
 * still applies. On the landing page this let headings ghost through the fixed header
 * everywhere except Safari. Lightning CSS adds whatever prefix the browserslist needs on
 * its own; writing it by hand is the bug.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const SRC = "src";
/** Classes whose whole point is the blur. Deleting BOTH lines must fail too, not just the twin. */
const MUST_BLUR = [".liquid-glass", ".landing-glass", ".landing-header-glass"];

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`  ${ok ? "ok  " : "FAIL"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

/** Blank out comments but keep their newlines, so reported line numbers stay true. */
function stripComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "));
}

function cssFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...cssFiles(full));
    else if (entry.endsWith(".css")) out.push(full);
  }
  return out;
}

function main() {
  console.log("Hand-written prefixed twins:");
  for (const file of cssFiles(SRC)) {
    const lines = stripComments(readFileSync(file, "utf8")).split("\n");
    // Declarations only: a line that STARTS with the property. An @supports condition such
    // as `(-webkit-backdrop-filter: blur(1px))` starts with "(" and is left alone.
    const hits = lines.flatMap((line, i) =>
      /^\s*-webkit-backdrop-filter\s*:/.test(line) ? [`${file}:${i + 1}`] : []
    );
    check(`${file} declares no -webkit-backdrop-filter`, hits.length === 0, hits.join(", "));
  }

  console.log("\nGlass classes still blur:");
  const globals = stripComments(readFileSync(join(SRC, "app/globals.css"), "utf8"));
  for (const selector of MUST_BLUR) {
    // The top-level rule for exactly this selector: unindented, and `.liquid-glass-panel`
    // does not match `.liquid-glass` because the brace must follow the name.
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const rule = new RegExp(`(^|\\n)${escaped}\\s*\\{([^}]*)\\}`).exec(globals);
    const body = rule?.[2] ?? "";
    check(
      `${selector} declares a standard backdrop-filter blur`,
      /(^|[;\s{])backdrop-filter\s*:\s*blur\(/.test(body),
      rule ? "" : "rule not found"
    );
  }

  if (failures > 0) {
    console.error(
      `\nFAILED: ${failures} check(s). Author only the standard \`backdrop-filter\`; Lightning CSS adds the prefix.`
    );
    process.exit(1);
  }
  console.log("\nEvery glass surface blurs.");
  process.exit(0);
}

main();
