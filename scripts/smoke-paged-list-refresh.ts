/**
 * `mergeRefreshedFirstPage` (src/lib/paged-list.ts): what a paged list shows when the server
 * re-sends its first page for the SAME list — which it does on every mutation re-render and
 * every return to the tab. It used to replace everything with page one.
 *
 * Pure. Run: npx tsx scripts/smoke-paged-list-refresh.ts
 */
import { mergeRefreshedFirstPage } from "../src/lib/paged-list";

let failures = 0;
function check(label: string, ok: boolean, detail?: string) {
  if (ok) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.error(`  FAIL ${label}${detail ? `\n       ${detail}` : ""}`);
  }
}

const row = (id: string, v = 0) => ({ id, v });
const ids = (rows: Array<{ id: string }>) => rows.map((r) => r.id).join(",");

// Three pages of two loaded: a b | c d | e f
const loaded = ["a", "b", "c", "d", "e", "f"].map((id) => row(id));

check("the pages scrolled in survive a refresh", ids(mergeRefreshedFirstPage(loaded, 2, [row("a", 1), row("b", 1)])) === "a,b,c,d,e,f");
check("the first page is the fresh one", mergeRefreshedFirstPage(loaded, 2, [row("a", 1), row("b", 1)])[0]!.v === 1);
check("a row gone from the first page is gone", ids(mergeRefreshedFirstPage(loaded, 2, [row("b"), row("c")])) === "b,c,d,e,f");
check("a row the fresh page now holds is not listed twice", ids(mergeRefreshedFirstPage(loaded, 2, [row("a"), row("c")])) === "a,c,d,e,f");
check("nothing past page one: just the fresh page", ids(mergeRefreshedFirstPage(loaded.slice(0, 2), 2, [row("x"), row("a")])) === "x,a");

if (failures) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nAll paged-list refresh checks passed");
