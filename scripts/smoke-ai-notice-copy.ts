/**
 * One AI-access state: which words each refusal gets, per plan (Sprint B, B2).
 *
 * Run: npx tsx scripts/smoke-ai-notice-copy.ts
 */
import { readFileSync } from "node:fs";
import {
  AI_ACCESS_COPY,
  AI_ACCESS_MESSAGES,
  BACKGROUND_RESERVE_MESSAGE,
  FREE_LIMIT_MESSAGE,
  hintCopyFor,
  noticeCopyFor,
  refusalCopyFor,
} from "../src/lib/ai-access-copy";

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

// The one-line refusal and the field hint: never a pack to a Free account (final review #3).
check("Free at zero: the one-line refusal is the Free message", refusalCopyFor("managed_limit", "free") === FREE_LIMIT_MESSAGE);
check("Pro at zero keeps the pack line", refusalCopyFor("managed_limit", "orbit") === AI_ACCESS_COPY.managed_limit);
check("null reason is key_required", refusalCopyFor(null, "free") === AI_ACCESS_COPY.key_required);
const freeHint = hintCopyFor("managed_limit", "free");
check("Free at zero: the hint never offers a pack", !/pack/i.test(freeHint) && /api key/i.test(freeHint), freeHint);
check("…and obeys the copy rules", !/\.$/.test(freeHint) && (freeHint.match(/ — /g) ?? []).length <= 1 && !freeHint.includes("'"), freeHint);
check("Pro at zero: the hint keeps the pack", /pack/i.test(hintCopyFor("managed_limit", "orbit")));
check("the background-reserve refusal is an own-words message", AI_ACCESS_MESSAGES.includes(BACKGROUND_RESERVE_MESSAGE));
check("…and obeys the copy rules", !/\.$/.test(BACKGROUND_RESERVE_MESSAGE) && (BACKGROUND_RESERVE_MESSAGE.match(/ — /g) ?? []).length <= 1 && !BACKGROUND_RESERVE_MESSAGE.includes("'"));
for (const file of ["src/actions/events.ts", "src/components/contacts/log-interaction-sheet.tsx", "src/components/settings/ai-settings.tsx"]) {
  const src = readFileSync(file, "utf8");
  check(`${file} words refusals per plan, never a raw copy table lookup`, !/AI_(ACCESS|HINT|NOTICE)_COPY\[/.test(src));
}

if (failures) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log("\nai-notice-copy: ok");
process.exit(0);
