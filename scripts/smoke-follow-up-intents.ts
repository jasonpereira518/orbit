/**
 * Pins the four follow-up intent chips (labels and the exact instruction copy), and that both
 * draft surfaces render them with the intent field always visible.
 * Run: npx tsx scripts/smoke-follow-up-intents.ts
 */
import { readFileSync } from "node:fs";
import { FOLLOW_UP_INTENTS } from "../src/lib/follow-up-intents";

let failures = 0;
const fail = (m: string) => { failures++; console.error(`  FAIL ${m}`); };
const want = [
  ["Thank you", "Thank them for their time and mention one specific thing from our conversation"],
  ["Referral ask", "Ask if they’d be open to referring me for a role on their team, and offer to send my resume"],
  ["Informational chat", "Ask for 20 minutes to hear about their path and their team"],
  ["Keep me in mind", "A short, warm note to stay in touch and ask them to keep me in mind for future roles"],
];
if (JSON.stringify(FOLLOW_UP_INTENTS.map((i) => [i.label, i.instruction])) !== JSON.stringify(want)) fail("intent labels or copy changed");
for (const i of FOLLOW_UP_INTENTS) {
  if (/'/.test(i.instruction)) fail(`${i.label}: straight apostrophe`);
  if (/\.$/.test(i.instruction)) fail(`${i.label}: trailing period`);
}
for (const file of ["src/components/contacts/contact-follow-up-section.tsx", "src/components/follow-up/follow-up-draft-sheet.tsx"]) {
  const src = readFileSync(file, "utf8");
  if (!src.includes("FOLLOW_UP_INTENTS")) fail(`${file} does not render the intent chips`);
  if (/initialIntent \|\| intent \?/.test(src)) fail(`${file} still hides the intent field until one is set`);
}
if (failures) { console.error(`\n${failures} intent check(s) failed`); process.exit(1); }
console.log("all intent checks passed");
process.exit(0);
