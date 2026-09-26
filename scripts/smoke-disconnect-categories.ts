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
// Exactly `["recruiters"]`, not merely including it. The Google and Microsoft account pages
// (`src/components/settings/google-account-page.tsx`, `microsoft-account-page.tsx`) decide
// whether the disconnect dialog has anything to offer from the recruiter scan alone: a read
// that ran, succeeded and found no scan means "nothing to delete", and the checkbox is
// dropped. That inference holds only while the recruiter scan is the whole list. A second
// category added here would be silently hidden on both pages for every account that has
// never scanned — so this fails loudly instead.
const only = (ids: readonly string[], one: string) => ids.length === 1 && ids[0] === one;
check("Google offers the recruiter scan data and nothing else", only(DISCONNECT_DELETE_CATEGORIES.gmail, "recruiters"));
check("Outlook offers the recruiter scan data and nothing else", only(DISCONNECT_DELETE_CATEGORIES.outlook, "recruiters"));

if (failures > 0) process.exit(1);
console.log("\nAll disconnect-category checks passed.");
process.exit(0);
