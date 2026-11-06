/**
 * Cold-start guard: what every signed-in page's server render has to load.
 *
 * `(app)/layout.tsx` runs on every signed-in page, so anything its static import graph
 * reaches is evaluated by every cold instance. Twice the graph quietly tripled — through
 * `site-access.ts` importing the `admin-operations` barrel (fixed in #314), then through
 * `linkedin-reminder.ts` importing a string constant from the LinkedIn messages adapter,
 * which reached `ai.ts` and the relationship engine (Oct 2026: 147 files → 68 once fixed).
 * Both regressions were one innocent-looking import, so this checks the parsed graph, not
 * a grep.
 *
 *   npx tsx scripts/smoke-server-graph.ts
 */
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { chainTo, serverImportGraph } from "./lib/import-graph";

const LAYOUT = "src/app/(clerk)/(app)/layout.tsx";
/** Room to grow from 68 (Oct 2026), but not another tripling. */
const LAYOUT_MAX_FILES = 90;
/** Modules that must never load on every page: heavy, and needed only by specific actions. */
const LAYOUT_BANNED = [
  "src/lib/ai.ts",
  "src/lib/relationship-engine/",
  "src/lib/import-engine.ts",
  "src/lib/linkedin-timeline-backfill.ts",
  "src/lib/caldav/",
  "src/lib/admin-operations.ts",
];

let failures = 0;
function check(label: string, ok: boolean, detail?: string) {
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${label}${ok || !detail ? "" : `\n        ${detail}`}`);
  if (!ok) failures++;
}

const layout = serverImportGraph(LAYOUT);
check(`(app) layout server graph ≤ ${LAYOUT_MAX_FILES} files (now ${layout.size})`, layout.size <= LAYOUT_MAX_FILES);
for (const banned of LAYOUT_BANNED) {
  const hit = [...layout.keys()].find((f) => f.startsWith(banned));
  check(`(app) layout never reaches ${banned}`, !hit, hit && chainTo(layout, hit).join("\n        → "));
}

// The admin-operations barrel re-exports the import engine, Gmail and Outlook; a signed-in
// page reaching it pays for all of them. Import `recordAdminAction` from `admin-audit`.
function pages(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return pages(path);
    return name === "page.tsx" ? [path] : [];
  });
}
for (const page of pages("src/app/(clerk)/(app)")) {
  const graph = serverImportGraph(page);
  const hit = graph.has("src/lib/admin-operations.ts");
  check(
    `${page} never reaches the admin-operations barrel`,
    !hit,
    hit ? chainTo(graph, "src/lib/admin-operations.ts").join("\n        → ") : undefined
  );
}

if (failures) {
  console.error(`\nsmoke-server-graph: ${failures} failure(s)`);
  process.exit(1);
}
console.log("\nsmoke-server-graph: all ok");
