/**
 * The constellation and the contact cards resolve a name to the same brand.
 *
 * Both read the one raw table in `src/lib/brand-colors.ts` and apply their own surface
 * treatment on top (dark-sky lift in `school-color.ts`, UI legibility in `company-brand.ts`).
 * Before that they kept two tables that disagreed, and the card table had no schools.
 * Pure: no database, no network.
 * Run: npx tsx scripts/smoke-brand-colors.ts
 */
import { brandKey, lookupBrand } from "@/lib/brand-colors";
import { companyBrandColor as cardColor, uiFriendlyBrand } from "@/lib/company-brand";
import {
  clusterBrandColor,
  companyBrandColor as skyCompanyColor,
  mapFriendlyBrand,
  schoolStarColor,
} from "@/lib/school-color";

let failures = 0;
function check(label: string, ok: boolean, detail?: string) {
  if (ok) console.log(`  ok   ${label}`);
  else {
    console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ""}`);
    failures++;
  }
}

console.log("both consumers resolve the same brand");
const SAME: Array<[name: string, expected: string, kind: "company" | "school"]> = [
  ["Stripe", "#635BFF", "company"],
  ["UNC Chapel Hill", "#4B9CD3", "school"],
  ["Google Cloud", "#4285F4", "company"],
  ["Anthropic", "#D4A27F", "company"],
];
for (const [name, expected, kind] of SAME) {
  const brand = lookupBrand(name);
  check(`${name} is a known ${kind}`, brand?.hex === expected && brand.kind === kind, JSON.stringify(brand));
  const sky = clusterBrandColor(name, kind);
  const card = cardColor(name);
  check(`${name}: sky ${sky} is the dark-sky treatment of ${expected}`, sky === mapFriendlyBrand(expected));
  check(`${name}: card ${card} is the UI treatment of ${expected}`, card === uiFriendlyBrand(expected));
  check(`${name}: sky and card agree`, sky === card, `${sky} vs ${card}`);
}

// A contact who WORKS at a school gets the school's color on the card (exact cross-table hit),
// and the constellation infers the school when no kind is given.
check("card for company 'UNC Chapel Hill' is Carolina blue", cardColor("UNC Chapel Hill") === "#4B9CD3");
check("sky infers UNC as a school without a kind", clusterBrandColor("UNC Chapel Hill") === "#4B9CD3");
check("schoolStarColor('University of North Carolina at Chapel Hill')", schoolStarColor("University of North Carolina at Chapel Hill") === "#4B9CD3");

console.log("\nshort keys match whole words only");
for (const name of ["Exxon", "ExxonMobil", "Box", "Xerox", "Utah Jazz", "Metaverse Labs"]) {
  check(`'${name}' resolves to no brand`, lookupBrand(name) === null, JSON.stringify(lookupBrand(name)));
  check(`'${name}' card falls back to the hash tint`, cardColor(name)?.startsWith("hsl(") === true, String(cardColor(name)));
}
check("'X' itself is X", lookupBrand("X")?.name === "X");
check("'X Corp' is X (whole word)", lookupBrand("X Corp")?.name === "X");
check("'IBM Watson' is IBM", lookupBrand("IBM Watson")?.name === "IBM");
check("'Meta Platforms, Inc.' is Meta", lookupBrand("Meta Platforms, Inc.")?.name === "Meta");
check("'Penn State' is not UPenn", lookupBrand("Penn State")?.name === "Penn State");
check("'J.P. Morgan' and 'JP Morgan' share a key", brandKey("J.P. Morgan") === brandKey("JP Morgan"));

console.log("\neach consumer keeps its own contract");
check("card returns null for empty", cardColor("") === null && cardColor("   ") === null && cardColor(null) === null);
check("card greys a monochrome brand", cardColor("Vercel") === "#9CA3AF");
check("sky lifts a monochrome brand", skyCompanyColor("Vercel") === "#6B7C93");
check("card hash fallback keeps its shape", cardColor("Acme Widgets") === cardColor("  acme   WIDGETS "));
check("sky neutral for empty school", schoolStarColor("") === "#c8d0dc");

if (failures) {
  console.error(`\nsmoke-brand-colors: ${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nsmoke-brand-colors: all checks passed");
process.exit(0);
