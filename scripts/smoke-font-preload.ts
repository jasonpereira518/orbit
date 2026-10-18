/**
 * Only the fonts every page renders are preloaded (LATENCY_PLAN NET-3).
 *
 * `next/font` preloads every file of a declaration on every page. Fraunces' italic (45 KB)
 * used to share a declaration with the upright, so every app page preloaded a face only
 * the pricing and waitlist headlines use: 3 → 2 preloaded fonts, 114 → 69 KB.
 * This pins the split, and the CSS rule that keeps those headlines on the true italic.
 *
 * Pure (reads source). Run: npx tsx scripts/smoke-font-preload.ts
 */
import { readFileSync } from "node:fs";

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

const layout = readFileSync("src/app/layout.tsx", "utf8");
const declarations = [...layout.matchAll(/=\s*(\w+)\(\{([\s\S]*?)\}\);/g)].map((m) => ({ font: m[1]!, body: m[2]! }));
const preloaded = declarations.filter((d) => !/preload:\s*false/.test(d.body));
const italic = declarations.filter((d) => /style:\s*\[[^\]]*"italic"/.test(d.body));

check("every font declaration is found", declarations.length >= 3, declarations.map((d) => d.font).join(", "));
check("no preloaded declaration carries an italic", preloaded.every((d) => !/"italic"/.test(d.body)));
check("Fraunces' italic is declared, not preloaded", italic.length === 1 && /preload:\s*false/.test(italic[0]!.body) && italic[0]!.font === "Fraunces");
check("and exposed on <html> as --font-display-italic", /variable:\s*"--font-display-italic"/.test(italic[0]?.body ?? "") && /frauncesItalic\.variable/.test(layout));

const theme = readFileSync("src/app/theme.css", "utf8");
check(
  "theme.css sends display-serif italics to that face",
  /:where\(\.font-heading, \[class\*="var\(--font-display\)"\]\) :where\(em, i, \.italic\)/.test(theme) &&
    /font-family: var\(--font-display-italic\), var\(--font-display\)/.test(theme)
);

console.log(failures === 0 ? "\nAll font preload checks passed." : `\n${failures} check(s) FAILED.`);
if (failures) process.exit(1);
