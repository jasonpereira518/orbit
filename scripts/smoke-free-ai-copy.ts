/**
 * Free includes a small AI allowance (Sprint B). Pins that no plan or pricing copy still says
 * Free needs its own key, and that the Free card names the numbers from PLAN_CONFIG.
 *
 * Run: npx tsx scripts/smoke-free-ai-copy.ts
 */
import { readFileSync } from "node:fs";
import { FREE_STARTER_CREDITS, PLAN_CONFIG } from "../src/lib/plans/plan-config";
import { AI_POSITIONING, PLAN_COPY } from "../src/lib/plan-copy";

let failures = 0;
function check(label: string, ok: boolean, detail?: unknown) {
  if (ok) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.error(`  FAIL ${label}${detail === undefined ? "" : `\n       ${JSON.stringify(detail)}`}`);
  }
}

const free = PLAN_COPY.find((p) => p.id === "free")!;
const line = `${PLAN_CONFIG.free.monthlyCredits} AI credits a month + ${FREE_STARTER_CREDITS} to start`;
check("the Free card lists the allowance and the starter", free.features.some((f) => f.includes(line)), free.features);
check("the Free card no longer says 'on your own AI key'", !free.features.some((f) => /own AI key/i.test(f)), free.features);
check("positioning no longer says Free is bring-your-own-key", !/Free: bring your own/i.test(AI_POSITIONING), AI_POSITIONING);

const sources = [
  "src/components/pricing/pricing-faq.tsx",
  "src/components/pricing/plan-comparison.tsx",
  "src/app/(clerk)/(marketing)/pricing/page.tsx",
  "src/lib/entitlements.ts",
  "src/app/(site)/(docs)/privacy/page.tsx",
  "src/app/(site)/(docs)/terms/page.tsx",
];
for (const file of sources) {
  const src = readFileSync(file, "utf8").replace(/\s+/g, " ");
  check(`${file}: no "Free … own key" promise`,
    !/On the Free Plan(,| and Orbit Lifetime,)? (yes|every call runs on|AI runs on|add your own AI)/i.test(src) &&
      !/Bring your own AI key on the Free Plan/i.test(src) && !/AI on it runs on a key you supply/i.test(src));
}

if (failures) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log("\nfree-ai-copy: ok");
process.exit(0);
