/**
 * The admin console was folded into eight sections (Nov 2026); old URLs redirect.
 *
 * Asserts, for every entry in ADMIN_REDIRECTS: the source no longer has a page (Next runs
 * `redirects()` before the filesystem, so a leftover page would be dead code nobody can
 * reach), the destination IS a page, and it sits under the gated `(clerk)/(admin)` layout.
 * Also: every nav item and section tab points at a real page.
 *
 * Run: npx tsx scripts/smoke-admin-redirects.ts
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { ADMIN_REDIRECTS } from "../src/lib/admin-redirects";
import { ADMIN_NAV, ADMIN_YC_NAV } from "../src/components/admin/admin-nav";
import {
  ACCESS_TABS,
  FEEDBACK_TABS,
  GROWTH_TABS,
  MONEY_TABS,
  OPS_TABS,
  PRODUCT_TABS,
  USERS_TABS,
} from "../src/components/admin/admin-tabs";

const GATED = join(process.cwd(), "src/app/(clerk)/(admin)");
const pageFor = (path: string) => join(GATED, path, "page.tsx");

let failures = 0;
function check(label: string, ok: boolean) {
  if (ok) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.error(`  FAIL ${label}`);
  }
}

check("the gated layout exists", existsSync(join(GATED, "layout.tsx")));

const sources = new Set<string>();
for (const { source, destination } of ADMIN_REDIRECTS) {
  check(`${source} is listed once`, !sources.has(source));
  sources.add(source);
  check(`${source} has no page left behind`, !existsSync(pageFor(source)));
  check(`${source} → ${destination} lands on a gated page`, existsSync(pageFor(destination)));
  check(`${destination} is not itself redirected`, !ADMIN_REDIRECTS.some((r) => r.source === destination));
}

const tabs = [ACCESS_TABS, FEEDBACK_TABS, GROWTH_TABS, MONEY_TABS, OPS_TABS, PRODUCT_TABS, USERS_TABS].flat();
for (const { href } of [...ADMIN_NAV, ...ADMIN_YC_NAV, ...tabs]) {
  check(`${href} is a gated page`, existsSync(pageFor(href)));
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log("\nAll admin redirect checks passed.");
