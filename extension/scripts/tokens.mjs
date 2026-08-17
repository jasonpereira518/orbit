/**
 * Keeps the extension's design tokens in step with the Orbit app.
 *
 * The app's globals.css can't just be imported: it pulls in shadcn's Tailwind
 * layer, Clerk's theme CSS, landing-page gradients, and graph styles — tens of
 * KB of irrelevance for a 400px panel, plus a hard dependency on the Next app's
 * node_modules from a separate Vite project.
 *
 * So the token blocks are copied, and this script is what stops the copy from
 * drifting. `sync` regenerates, `check` fails the build on divergence.
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const SOURCE = join(here, "../../src/app/globals.css");
const TARGET = join(here, "../src/styles/tokens.css");

/** Pull a top-level block by its selector, brace-matched. */
function block(css, selector) {
  const start = css.indexOf(selector);
  if (start === -1) throw new Error(`Missing block: ${selector}`);
  const open = css.indexOf("{", start);
  let depth = 0;
  for (let i = open; i < css.length; i++) {
    if (css[i] === "{") depth++;
    else if (css[i] === "}") {
      depth--;
      if (depth === 0) return css.slice(start, i + 1);
    }
  }
  throw new Error(`Unterminated block: ${selector}`);
}

const SELECTORS = [
  // Maps the CSS variables onto Tailwind's colour names, so `bg-background`
  // and friends resolve the same way they do in the app.
  "@theme inline {",
  "@theme {",
  ":root {",
  ".dark {",
  ".reveal-mount {",
];

function generate() {
  const css = readFileSync(SOURCE, "utf8");
  const blocks = SELECTORS.map((selector) => block(css, selector));
  return [
    "/*",
    " * GENERATED — do not edit by hand.",
    " * Copied from src/app/globals.css by scripts/tokens.mjs.",
    " * Run `npm run tokens:sync` after changing the app's tokens;",
    " * `npm run check:tokens` fails the build if these drift.",
    " */",
    "",
    ...blocks,
    "",
  ].join("\n");
}

const mode = process.argv[2] ?? "check";
const generated = generate();

if (mode === "sync") {
  writeFileSync(TARGET, generated);
  console.log(`tokens.css synced from ${SOURCE}`);
} else {
  if (!existsSync(TARGET)) {
    console.error("tokens.css is missing — run `npm run tokens:sync`.");
    process.exit(1);
  }
  if (readFileSync(TARGET, "utf8") !== generated) {
    console.error(
      "tokens.css has drifted from the app's globals.css — run `npm run tokens:sync`."
    );
    process.exit(1);
  }
  console.log("tokens.css is in sync.");
}
