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
  schoolStarColor,
  skyBrandColor,
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
  ["Anthropic", "#D97757", "company"],
];
for (const [name, expected, kind] of SAME) {
  const brand = lookupBrand(name);
  check(`${name} is a known ${kind}`, brand?.hex === expected && brand.kind === kind, JSON.stringify(brand));
  if (!brand) continue;
  const sky = clusterBrandColor(name, kind);
  const card = cardColor(name);
  // The same brand on both surfaces, each through its own treatment.
  check(`${name}: sky ${sky} is the sky treatment of ${brand.name}`, sky === skyBrandColor(brand));
  check(`${name}: card ${card} is the UI treatment of ${expected}`, card === uiFriendlyBrand(expected));
  check(`${name}: kind-less sky lookup finds the same brand`, clusterBrandColor(name) === sky);
}
// Stripe's sky violet is a sky-only override; the card keeps the true blurple.
check("Stripe card is the raw #635BFF", cardColor("Stripe") === "#635BFF");
check("Stripe sky is the nudged violet", clusterBrandColor("Stripe", "company") === "#9061F9");

// A contact who WORKS at a school gets the school's color on the card (exact cross-table hit),
// and the constellation infers the school when no kind is given.
check("card for company 'UNC Chapel Hill' is Carolina blue", cardColor("UNC Chapel Hill") === "#4B9CD3");
check("sky infers UNC as a school without a kind", clusterBrandColor("UNC Chapel Hill") === "#4B9CD3");
check("schoolStarColor('University of North Carolina at Chapel Hill')", schoolStarColor("University of North Carolina at Chapel Hill") === "#4B9CD3");

console.log("\nshort keys match whole words only");
for (const name of ["Exxon", "ExxonMobil", "Box", "Xerox", "Utah Jazz", "Utah State", "Metaverse Labs"]) {
  check(`'${name}' resolves to no brand`, lookupBrand(name) === null, JSON.stringify(lookupBrand(name)));
  check(`'${name}' card falls back to the hash tint`, cardColor(name)?.startsWith("hsl(") === true, String(cardColor(name)));
}
check("'X' itself is X", lookupBrand("X")?.name === "X");
check("'X Corp' is X (whole word)", lookupBrand("X Corp")?.name === "X");
check("'IBM Watson' is IBM", lookupBrand("IBM Watson")?.name === "IBM");
check("'Meta Platforms, Inc.' is Meta", lookupBrand("Meta Platforms, Inc.")?.name === "Meta");
check("'Carnegie' is Carnegie Mellon (name inside a known alias)", lookupBrand("Carnegie")?.name === "Carnegie Mellon University");
check("'Boston College' is not Boston University", lookupBrand("Boston College")?.name === "Boston College");
check("company 'Duke Capital Partners' is not Duke blue", lookupBrand("Duke Capital Partners", "company") === null);
check("'Penn State' is not UPenn", lookupBrand("Penn State")?.name === "Penn State");
check("'J.P. Morgan' and 'JP Morgan' share a key", brandKey("J.P. Morgan") === brandKey("JP Morgan"));

console.log("\neach consumer keeps its own contract");
check("card returns null for empty", cardColor("") === null && cardColor("   ") === null && cardColor(null) === null);
check("card greys a monochrome brand", cardColor("Vercel") === "#9CA3AF");
check("sky draws a black brand as a visible grey", /^#([0-9a-f]{2})\1\1$/i.test(skyCompanyColor("Vercel")));
check("sky keeps Duke blue (lifted within its hue, not greyed)", (() => {
  const c = schoolStarColor("Duke University");
  return c !== "#003087" && parseInt(c.slice(5, 7), 16) > parseInt(c.slice(1, 3), 16);
})());
check("card hash fallback keeps its shape", cardColor("Acme Widgets") === cardColor("  acme   WIDGETS "));
check("sky neutral for empty school", schoolStarColor("") === "#c8d0dc");

if (failures) {
  console.error(`\nsmoke-brand-colors: ${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nsmoke-brand-colors: all checks passed");
process.exit(0);
