/**
 * One AI-access state: which words each refusal gets, per plan (Sprint B, B2).
 *
 * Run: npx tsx scripts/smoke-ai-notice-copy.ts
 */
import { noticeCopyFor } from "../src/lib/ai-access-copy";

let failures = 0;
function check(label: string, ok: boolean, detail?: unknown) {
  if (ok) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.error(`  FAIL ${label}${detail === undefined ? "" : `\n       ${JSON.stringify(detail)}`}`);
  }
}

const reset = "2026-11-01T00:00:00.000Z";
const freeOut = noticeCopyFor("managed_limit", "free", reset);
check("Free out of credits names the refill date", freeOut.title("x") === "You’ve used this month’s AI credits" && freeOut.body.includes("November 1"), freeOut.body);
check("…offers a key and plans, never a pack", freeOut.offer === "plans" && !/pack/i.test(freeOut.body));
check("…obeys the copy rules", !/\.$/.test(freeOut.body) && (freeOut.body.match(/ — /g) ?? []).length <= 1 && !freeOut.body.includes("'"));
const rendered = `${freeOut.body} — add your own key for no limit under Settings → Integrations → AI provider, or compare plans.`;
check("…reads as one sentence with the notice lead-in", freeOut.body === "They refill on November 1" && (rendered.match(/ — /g) ?? []).length === 1 && !/  /.test(rendered), rendered);
check("Pro out of credits keeps the pack offer", noticeCopyFor("managed_limit", "orbit", reset).offer === "credits");
check("key_required no longer says 'On the Free Plan'", !/Free Plan/.test(noticeCopyFor("key_required", "lifetime", null).body));
check("paused reads the same on every plan", noticeCopyFor("managed_unavailable", "free", reset).title("x") === "Orbit’s AI isn’t available right now");
check("null reason falls back to key_required", noticeCopyFor(null, "lifetime", null).title("chat") === "Add an AI API key to chat");

if (failures) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log("\nai-notice-copy: ok");
process.exit(0);
