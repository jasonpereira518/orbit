/**
 * Every signed-in app page renders `<RenderStamp />`, the marker `FreshOnArrival` uses to
 * refresh a page that a prefetch or the router cache served old (see docs/performance.md,
 * "Instant, but never old"). A page without one would show a copy up to a minute old and
 * never correct it. A static scan of the page files: no server, no database.
 *
 * Run: npx tsx scripts/smoke-render-stamp-pages.ts
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = join(__dirname, "..", "src", "app", "(clerk)", "(app)");

/**
 * Pages that deliberately go without. Onboarding is a single client-driven flow whose step
 * lives in client state; a refresh would buy nothing there.
 */
const EXEMPT = new Set(["onboarding/page.tsx", "onboarding/wizard/page.tsx"]);

function pages(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return pages(path);
    return name === "page.tsx" ? [path] : [];
  });
}

let failures = 0;
const found = pages(ROOT);
for (const path of found) {
  const rel = relative(ROOT, path).replace(/\(main\)\//, "");
  if (EXEMPT.has(rel)) continue;
  const src = readFileSync(path, "utf8");
  const ok = src.includes("<RenderStamp />") && src.includes('from "@/components/layout/render-stamp"');
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${rel}`);
  if (!ok) failures++;
}

if (found.length < 20) {
  console.log(`  FAIL  only ${found.length} pages found — has the route group moved?`);
  failures++;
}
if (failures) {
  console.error(`\n${failures} page(s) without <RenderStamp />`);
  process.exit(1);
}
console.log(`\nAll ${found.length - EXEMPT.size} app pages render <RenderStamp />.`);
process.exit(0);
