/**
 * What "Also delete what Orbit imported" may delete. Run: npx tsx scripts/smoke-disconnect-categories.ts
 */
import {
  DATA_CATEGORY_IDS,
  DISCONNECT_DELETE_CATEGORIES,
  expandCategories,
} from "../src/lib/data-categories";

let failures = 0;
function check(label: string, ok: boolean) {
  if (ok) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.error(`  FAIL ${label}`);
  }
}

for (const [provider, ids] of Object.entries(DISCONNECT_DELETE_CATEGORIES)) {
  check(`${provider}: every id is a real category`, ids.every((id) => DATA_CATEGORY_IDS.includes(id)));
  // `contacts` implies notes, reminders and insights — the whole network, never "what one
  // account imported".
  check(`${provider}: never reaches contacts`, !expandCategories(ids).has("contacts"));
  check(`${provider}: expands to nothing it did not name`, expandCategories(ids).size === ids.length);
}
check("Google offers the recruiter scan's data", DISCONNECT_DELETE_CATEGORIES.gmail.includes("recruiters"));
check("Outlook offers nothing (it only fills contacts)", DISCONNECT_DELETE_CATEGORIES.outlook.length === 0);

if (failures > 0) process.exit(1);
console.log("\nAll disconnect-category checks passed.");
process.exit(0);
