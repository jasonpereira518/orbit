/**
 * One AI-access state: which words each refusal gets, per plan (Sprint B, B2).
 *
 * Run: npx tsx scripts/smoke-ai-notice-copy.ts
 */
import { readFileSync } from "node:fs";
import {
  AI_ACCESS_COPY,
  AI_ACCESS_MESSAGES,
  aiDenialFromMessage,
  BACKGROUND_RESERVE_MESSAGE,
  FREE_LIMIT_MESSAGE,
  MANAGED_LIMIT_MESSAGES,
  MANAGED_PROVIDER_FAILURE_MESSAGE,
  hintCopyFor,
  noticeCopyFor,
  refusalCopyFor,
  refusalWithRefill,
  unavailableCopyFor,
  AI_NOTICE_COPY,
  OWN_KEY_PROVIDERS,
} from "../src/lib/ai-access-copy";
import { isQuietFailureMessage } from "../src/lib/errors";

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
check("…offers a pack, like Pro", freeOut.offer === "credits" && /pack of 250 credits/i.test(freeOut.body));
check("…and a move to Orbit Pro", /move to Orbit Pro/.test(freeOut.body), freeOut.body);
check("…says nothing is charged automatically", /nothing is charged automatically/.test(freeOut.body) && !freeOut.body.includes("'"));
const rendered = `${freeOut.body} Or use your own key under Settings → Integrations → AI provider.`;
check("…reads as whole sentences with the notice lead-in", /\.$/.test(freeOut.body) && (rendered.match(/ — /g) ?? []).length === 1 && !/  /.test(rendered), rendered);
check("Pro out of credits keeps the pack offer", noticeCopyFor("managed_limit", "orbit", reset).offer === "credits");

// Out of credits, per plan. The rule is `creditPacks` (who can buy a pack), not "is this Free":
// Free offers a pack and Pro; Pro a pack and Max; Max a pack only; Lifetime neither, just a key.
const OUT = {
  free: noticeCopyFor("managed_limit", "free", reset),
  orbit: noticeCopyFor("managed_limit", "orbit", reset),
  max: noticeCopyFor("managed_limit", "max", reset),
  lifetime: noticeCopyFor("managed_limit", "lifetime", reset),
};
check("Pro: a pack and a move to Orbit Max", OUT.orbit.offer === "credits" && /pack of 250 credits/.test(OUT.orbit.body) && /move to Orbit Max/.test(OUT.orbit.body), OUT.orbit.body);
check("Max: a pack, and never a move to Max or to Pro", OUT.max.offer === "credits" && /pack of 250 credits/.test(OUT.max.body) && !/move to/.test(OUT.max.body), OUT.max.body);
check("Lifetime: no pack offer, no plan move, a key", OUT.lifetime.offer === null && !/pack/i.test(OUT.lifetime.body) && !/move to/.test(OUT.lifetime.body) && /key/.test(OUT.lifetime.body), OUT.lifetime.body);
check("Lifetime's notice still links to the keys", OUT.lifetime.linkToKeys);
for (const plan of ["free", "orbit", "max", "lifetime"] as const) {
  const body = OUT[plan].body;
  check(`${plan}: the out-of-credits notice obeys the copy rules`, !/  /.test(body) && (body.match(/ — /g) ?? []).length <= 1 && !body.includes("'") && /\.$/.test(body), body);
}

// The one-line refusal, hint and quiet/denial classification, per plan.
for (const plan of ["free", "orbit", "max", "lifetime"] as const) {
  const line = refusalCopyFor("managed_limit", plan);
  check(`${plan}: the refusal line is its own plan's message`, line === MANAGED_LIMIT_MESSAGES[plan]);
  check(`${plan}: the refusal keeps "API key", reads back as managed_limit and is quiet`,
    /api key/i.test(line) && aiDenialFromMessage(line) === "managed_limit" && isQuietFailureMessage(line) && AI_ACCESS_MESSAGES.includes(line), line);
  check(`${plan}: the refusal obeys the copy rules`, !/\.$/.test(line) && (line.match(/ — /g) ?? []).length <= 1 && !line.includes("'"), line);
  check(`${plan}: the hint keeps "API key"`, /api key/i.test(hintCopyFor("managed_limit", plan)), hintCopyFor("managed_limit", plan));
}
check("Free's refusal offers a pack and Pro", /\$5 pack/.test(MANAGED_LIMIT_MESSAGES.free) && /move to Pro/.test(MANAGED_LIMIT_MESSAGES.free));
check("Pro's refusal offers a pack and Max", /\$5 pack/.test(MANAGED_LIMIT_MESSAGES.orbit) && /move to Max/.test(MANAGED_LIMIT_MESSAGES.orbit));
check("Max's refusal offers a pack and never Max", /\$5 pack/.test(MANAGED_LIMIT_MESSAGES.max) && !/move to/.test(MANAGED_LIMIT_MESSAGES.max));
check("Lifetime's refusal offers no pack and no plan move", !/pack/i.test(MANAGED_LIMIT_MESSAGES.lifetime) && !/move to/.test(MANAGED_LIMIT_MESSAGES.lifetime));
check("Max and Lifetime hints: only Max offers a pack", /pack/i.test(hintCopyFor("managed_limit", "max")) && !/pack/i.test(hintCopyFor("managed_limit", "lifetime")));
check("the plan-neutral fallback offers nothing a plan might lack", !/pack|move to/i.test(AI_ACCESS_COPY.managed_limit));
check("key_required no longer says 'On the Free Plan'", !/Free Plan/.test(noticeCopyFor("key_required", "lifetime", null).body));
check("paused reads the same on every plan", noticeCopyFor("managed_unavailable", "free", reset).title("x") === "Orbit’s AI isn’t available right now");
check("null reason falls back to key_required", noticeCopyFor(null, "lifetime", null).title("chat") === "Add an AI API key to chat");

// Orbit's AI off, worded for why (R1): never "comes back on its own", since the admin pause has
// no date and a prepaid pool never refills. Paused, out until a date, out for now, or one call
// turned away while it runs.
const paused = unavailableCopyFor({ kind: "paused" });
const spentDated = unavailableCopyFor({ kind: "spent", refillsAt: "2026-11-15T00:00:00.000Z" });
const spentUndated = unavailableCopyFor({ kind: "spent", refillsAt: null });
const blip = unavailableCopyFor(null);
check("paused says paused", paused.title("x") === "Orbit’s AI is paused right now", paused.title("x"));
check("spent with a date names it", spentDated.title("x") === "Orbit’s AI is out until November 15", spentDated.title("x"));
check("spent without a date promises none", spentUndated.title("x") === "Orbit’s AI is out for now");
check("one refused call says try again", blip.title("x") === "Orbit’s AI couldn’t answer just now" && /Try again/.test(blip.body));
check("paused and spent both point at adding people by hand",
  [paused, spentDated, spentUndated].every((c) => /add people and set follow-ups by hand/.test(c.body)));
const offCopies = [paused, spentDated, spentUndated, blip, AI_NOTICE_COPY.managed_unavailable];
check("no unavailable copy promises AI comes back on its own", offCopies.every((c) => !/comes back on its own/i.test(c.body)));
for (const [label, c] of [["paused", paused], ["spent", spentDated], ["blip", blip], ["generic", AI_NOTICE_COPY.managed_unavailable]] as const) {
  check(`${label}: names every provider a key can be for`, c.body.includes(OWN_KEY_PROVIDERS), c.body);
  check(`${label}: obeys the copy rules`, /\.$/.test(c.body) && (c.body.match(/ — /g) ?? []).length <= 1 && !c.body.includes("'") && !/  /.test(c.body), c.body);
  check(`${label}: links to the keys and sells nothing`, c.linkToKeys && c.offer === null);
}
check("noticeCopyFor picks the outage wording when it is told one", noticeCopyFor("managed_unavailable", "free", reset, { kind: "paused" }).title("x") === paused.title("x"));
check("…the try-again wording when told Orbit's AI is running", noticeCopyFor("managed_unavailable", "free", reset, null).title("x") === blip.title("x"));
check("…and the generic wording when it is told nothing", noticeCopyFor("managed_unavailable", "free", reset).title("x") === AI_NOTICE_COPY.managed_unavailable.title("x"));
check("an outage never changes the out-of-credits wording", noticeCopyFor("managed_limit", "free", reset, { kind: "paused" }).offer === "credits");
check("key_required names every provider too", AI_NOTICE_COPY.key_required.body.includes(OWN_KEY_PROVIDERS));

// The one-line refusal and the field hint: Free at zero is told its credits are monthly, and offered a pack.
check("Free at zero: the one-line refusal is the Free message", refusalCopyFor("managed_limit", "free") === FREE_LIMIT_MESSAGE);
check("Pro at zero keeps the pack line", /pack/.test(refusalCopyFor("managed_limit", "orbit")));
check("null reason is key_required", refusalCopyFor(null, "free") === AI_ACCESS_COPY.key_required);
const freeHint = hintCopyFor("managed_limit", "free");
check("Free at zero: the hint offers a pack and a key", /pack/i.test(freeHint) && /api key/i.test(freeHint), freeHint);
check("…and obeys the copy rules", !/\.$/.test(freeHint) && (freeHint.match(/ — /g) ?? []).length <= 1 && !freeHint.includes("'"), freeHint);
check("Pro at zero: the hint keeps the pack", /pack/i.test(hintCopyFor("managed_limit", "orbit")));
check("the background-reserve refusal is an own-words message", AI_ACCESS_MESSAGES.includes(BACKGROUND_RESERVE_MESSAGE));
check("…and obeys the copy rules", !/\.$/.test(BACKGROUND_RESERVE_MESSAGE) && (BACKGROUND_RESERVE_MESSAGE.match(/ — /g) ?? []).length <= 1 && !BACKGROUND_RESERVE_MESSAGE.includes("'"));
for (const file of ["src/actions/events.ts", "src/components/contacts/log-interaction-sheet.tsx", "src/components/settings/ai-settings.tsx"]) {
  const src = readFileSync(file, "utf8");
  check(`${file} words refusals per plan, never a raw copy table lookup`, !/AI_(ACCESS|HINT|NOTICE)_COPY\[/.test(src));
}

// A refusal that went through reportedFailure can carry " (ref xxxx)"; it must still map.
check("Free-limit message with a ref maps to managed_limit", aiDenialFromMessage(`${FREE_LIMIT_MESSAGE} (ref abc123)`) === "managed_limit");
check("provider-failure message with a ref maps to managed_unavailable", aiDenialFromMessage(`${MANAGED_PROVIDER_FAILURE_MESSAGE} (ref x)`) === "managed_unavailable");
check("Free-limit message is a quiet failure (no ref appended)", isQuietFailureMessage(FREE_LIMIT_MESSAGE));
check("a refusal with a ref maps on every plan", (["free", "orbit", "max", "lifetime"] as const).every((p) => aiDenialFromMessage(`${MANAGED_LIMIT_MESSAGES[p]} (ref z)`) === "managed_limit"));
check("every account-state refusal is quiet", AI_ACCESS_MESSAGES.filter((m) => m !== MANAGED_PROVIDER_FAILURE_MESSAGE).every(isQuietFailureMessage));
check("Orbit's own provider failure is still reported", !isQuietFailureMessage(MANAGED_PROVIDER_FAILURE_MESSAGE));

// A one-line refusal (the constellation refresh's failed job) names the refill date on Free.
const refill = refusalWithRefill(FREE_LIMIT_MESSAGE, "free", "2026-11-01T00:00:00.000Z");
check("Free out of credits: the refusal line names the refill date", refill.includes("They refill on November 1"), refill);
check("…and obeys the copy rules", !/\.$/.test(refill) && (refill.match(/ — /g) ?? []).length <= 1 && !refill.includes("'"), refill);
check("…and still points at a key", /api key/i.test(refill), refill);
check("any other message passes through", refusalWithRefill("Something else broke", "free", null) === "Something else broke");
check("Pro out of credits passes through", refusalWithRefill(FREE_LIMIT_MESSAGE, "orbit", null) === FREE_LIMIT_MESSAGE);
check("Lifetime out of credits passes through", refusalWithRefill(MANAGED_LIMIT_MESSAGES.lifetime, "lifetime", null) === MANAGED_LIMIT_MESSAGES.lifetime);
const graph = readFileSync("src/components/graph/network-graph.tsx", "utf8");
check("the constellation refresh words its refusal with the refill date", /error: refusalWithRefill\(result\.aiError/.test(graph));

if (failures) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log("\nai-notice-copy: ok");
process.exit(0);
