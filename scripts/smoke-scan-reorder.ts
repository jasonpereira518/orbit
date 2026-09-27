/**
 * The phone page's Move earlier / Move later buttons: a pure, bounds-safe reorder.
 * Run: npx tsx scripts/smoke-scan-reorder.ts
 */
import { movePage } from "../src/lib/scan-capture";

function check(label: string, condition: boolean, detail?: string) {
  if (!condition) throw new Error(`${label} failed${detail ? `: ${detail}` : ""}`);
  console.log(`  ok  ${label}`);
}

const pages = ["a", "b", "c", "d"];
check("move later", movePage(pages, 0, 1).join("") === "bacd");
check("move earlier", movePage(pages, 3, 2).join("") === "abdc");
check("jump to the front", movePage(pages, 2, 0).join("") === "cabd");
check("beyond the end clamps", movePage(pages, 0, 9).join("") === "bcda");
check("before the start clamps", movePage(pages, 2, -4).join("") === "cabd");
check("no-op returns a copy", movePage(pages, 1, 1).join("") === "abcd" && movePage(pages, 1, 1) !== pages);
check("bad source index returns a copy", movePage(pages, 7, 0).join("") === "abcd");
check("the input is never mutated", pages.join("") === "abcd");

console.log("\nsmoke-scan-reorder: all checks passed");
