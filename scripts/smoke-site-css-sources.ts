/**
 * site.css builds the marketing pages' utilities only from the files listed in
 * src/app/site-sources.css. A marketing page that starts rendering a file missing from that
 * list gets no CSS for that file's classes — silently, in production only. This fails first.
 *
 *   npx tsx scripts/smoke-site-css-sources.ts      (fix: npm run css:site)
 */
import { readFileSync } from "node:fs";
import { SITE_SOURCES_FILE, siteCssSourcesText } from "./lib/site-css-sources";

let failures = 0;
function check(label: string, ok: boolean, detail?: string) {
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${label}${ok || !detail ? "" : `\n        ${detail}`}`);
  if (!ok) failures++;
}

const current = readFileSync(SITE_SOURCES_FILE, "utf8");
const expected = siteCssSourcesText();
const missing = expected.split("\n").filter((l) => l.startsWith("@source") && !current.includes(l));
check(
  `${SITE_SOURCES_FILE} lists every file the marketing pages render`,
  current === expected,
  missing.length ? `missing: ${missing.slice(0, 5).join(" ")} — run: npm run css:site` : "stale — run: npm run css:site"
);

// Each tree loads exactly one sheet: the root layout loads none, so a marketing page never
// pays for the app's utilities and an app page never lacks them.
const has = (file: string, css: string) => new RegExp(`import ["'][./]*${css}["']`).test(readFileSync(file, "utf8"));
check("the root layout loads no stylesheet", !has("src/app/layout.tsx", "globals\\.css") && !has("src/app/layout.tsx", "site\\.css"));
check("(site) loads site.css", has("src/app/(site)/layout.tsx", "site\\.css"));
check("(clerk) loads globals.css", has("src/app/(clerk)/layout.tsx", "globals\\.css"));
check("/scan loads globals.css", has("src/app/scan/[token]/page.tsx", "globals\\.css"));
check("not-found and global-error load site.css", has("src/app/not-found.tsx", "site\\.css") && has("src/app/global-error.tsx", "site\\.css"));

if (failures) {
  console.error(`\nsmoke-site-css-sources: ${failures} failure(s)`);
  process.exit(1);
}
console.log("\nsmoke-site-css-sources: all ok");
