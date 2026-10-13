/**
 * Free includes a small AI allowance (Sprint B). Pins that no plan or pricing copy still says
 * Free needs its own key, and that the Free card names the numbers from PLAN_CONFIG. A second
 * guard keeps the contact FAQ, plan cards, onboarding and tour copy and the README off
 * "AI runs on your key" (an optional own key may still be mentioned).
 *
 * Run: npx tsx scripts/smoke-free-ai-copy.ts
 */
import { readdirSync, readFileSync } from "node:fs";
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

// --- BYOK-era claims ---------------------------------------------------------------------
// Every plan includes AI now, so copy must not say AI "runs on your key" or that a key is
// needed. Mentioning an OPTIONAL own key is fine, so the "own key" pattern is exempt in a
// sentence that says it is optional; the key-era phrases below never are.
const KEY_ERA = [
  /runs on (an|your) [^.]*key/i,
  /\bno key (at all|needed)\b/i,
  /\badd a key in Settings\b/i,
  /\bneeds your AI key\b/i,
  /\bwith an AI key\b/i,
];
const OWN_KEY = /\bown (AI |API |provider )?key\b/i;
const OPTIONAL = /any plan|optional|you can|any time|prefer your own|never use credits|instead|unless/i;

function byokClaims(file: string, src: string): string[] {
  // Markdown and plain .ts hold roughly one string per line; JSX wraps a sentence across lines
  // and nests it in tags, so it is collapsed and split on both.
  const units = file.endsWith(".tsx") ? [src.replace(/\s+/g, " ")] : src.split("\n");
  return units
    .flatMap((unit) => unit.split(file.endsWith(".tsx") ? /(?<=[.?!])\s+|<[^>]*>/ : /(?<=[.?!])\s+/))
    .filter((sentence) => KEY_ERA.some((re) => re.test(sentence)) || (OWN_KEY.test(sentence) && !OPTIONAL.test(sentence)))
    .map((sentence) => sentence.trim().slice(0, 140));
}

console.log("\nBYOK-era claims");
const flagged = (text: string) => byokClaims("x.tsx", text).length > 0;
check("the guard flags the old claims", [
  "AI runs on your own provider key.",
  "On the Free Plan it runs on an API key you supply.",
  "Free for your first 500 contacts, with AI on your own provider key.",
  "| **AI** | Your own key | Included |",
  "A pasted LinkedIn URL logs a person with no key at all",
  "Needs your AI key",
  "Add a key in Settings when you’re ready.",
].every(flagged));
check("…and passes an optional own key", [
  "your own key is optional on any plan.",
  "You can add your own key on any plan.",
  "Add your own AI key any time for no limit.",
  "Prefer your own AI key? Add it any time; calls on it never use credits.",
].every((text) => !flagged(text)));

for (const file of [
  "src/app/(site)/(docs)/contact/page.tsx",
  "src/lib/plan-copy.ts",
  "src/components/onboarding/highlights/chapters.ts",
  "src/lib/tour/tour-stops.ts",
  "README.md",
]) {
  const claims = byokClaims(file, readFileSync(file, "utf8"));
  check(`${file}: no "AI needs your key" claim`, claims.length === 0, claims);
}

// Free connects ONE of Google or Outlook (PLAN_CONFIG.free.googleMicrosoftConnections); "both ...
// every plan" is false. Pure text scan of src, comments included.
const BOTH_EVERY_PLAN = /Google (and|&) (Outlook|Microsoft)[^.\n]{0,60}every plan/i;
check("the Free connection claim is checked as written", BOTH_EVERY_PLAN.test("Connecting Google and Outlook is free on every plan"));
const walk = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(`${dir}/${e.name}`) : /\.(tsx?|md)$/.test(e.name) ? [`${dir}/${e.name}`] : [],
  );
const bothEveryPlan = walk("src").filter((f) => BOTH_EVERY_PLAN.test(readFileSync(f, "utf8").replace(/\s+/g, " ")));
check("nothing under src says Google and Outlook are both free on every plan", bothEveryPlan.length === 0, bothEveryPlan);

if (failures) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log("\nfree-ai-copy: ok");
process.exit(0);
