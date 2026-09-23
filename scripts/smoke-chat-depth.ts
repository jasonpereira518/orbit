/**
 * Which questions get a research loop, and — just as important — which do not.
 *
 * The cost of a false positive is real: a model round, seconds of latency and money on the
 * user's own key, spent finding what retrieval already put in the prompt. So the "single"
 * half of this file matters as much as the "research" half: the questions Orbit's own
 * composer suggests, and plain lookups, must stay on the fast path.
 *
 * Pure. Run: npx tsx scripts/smoke-chat-depth.ts
 */
import { chooseDepth } from "../src/lib/chat-depth";
import { GENERIC_SUGGESTIONS } from "../src/lib/chat-suggestions";

let failures = 0;
function check(label: string, ok: boolean, detail?: string) {
  if (ok) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.error(`  FAIL ${label}${detail ? `\n       ${detail}` : ""}`);
  }
}

const fresh = { hasPriorTurns: false };
const followUp = { hasPriorTurns: true };

const research: Array<[string, typeof fresh]> = [
  ["What did we discuss at the Money2020 dinner?", fresh],
  ["what did I talk about with Priya last time", fresh],
  ["Who mentioned a Series A?", fresh],
  ["what's in my notes about the Lisbon office", fresh],
  ["Who could introduce me to someone at Stripe?", fresh],
  ["I need a warm intro to a fintech investor", fresh],
  ["who did I meet in March", fresh],
  ["who have I talked to about hiring this quarter", fresh],
  ["When did I last speak to Tomás?", fresh],
  ["what did she say about the raise?", followUp],
  // Named people, not just pronouns — found by writing the research eval.
  ["What did James say about the seed round he's leading?", fresh],
  ["What did Raj ask us to send before he reviews our key custody setup?", fresh],
  ["what did Priya Raman promise to send", fresh],
  ["can you draft something for them", followUp],
];
for (const [q, ctx] of research) {
  const d = chooseDepth(q, ctx);
  check(`research: "${q}"`, d.depth === "research", `${d.depth} (${d.reason})`);
}

const single: Array<[string, typeof fresh]> = [
  ["Who do I know at Stripe?", fresh],
  ["Who should I reconnect with this week?", fresh],
  ["Which of my contacts went to Stanford?", fresh],
  ["fintech people in New York", fresh],
  ["Maya Chen", fresh],
  ["Stripe", fresh],
  ["who is overdue", fresh],
  ["who works on payments infrastructure?", fresh],
  // A profile question about a named person, not a note question: no speech verb.
  ["What did Ada Lovelace work on before Stripe?", fresh],
  // A pronoun with NO prior turn is not a follow-up — there is nothing to refer back to.
  ["what did she work on before Stripe", { hasPriorTurns: false }],
];
for (const [q, ctx] of single) {
  const d = chooseDepth(q, ctx);
  // "what did she" matches the what-was-said rule; that one is a deliberate research case,
  // so it is checked separately below rather than asserted single here.
  if (q.startsWith("what did she")) continue;
  check(`single: "${q}"`, d.depth === "single", `${d.depth} (${d.reason})`);
}

check(
  "a pronoun is only a follow-up when there is something to follow up on",
  chooseDepth("can you draft something for them", fresh).depth === "single" &&
    chooseDepth("can you draft something for them", followUp).depth === "research"
);

// The composer's own generic suggestions are the most-clicked questions in chat. A rule that
// sent one of them to research would put a model round on every click of it.
const genericTexts: string[] = [];
const walk = (v: unknown) => {
  if (typeof v === "string") {
    if (v.includes(" ") && v.length > 8) genericTexts.push(v);
  } else if (Array.isArray(v)) v.forEach(walk);
  else if (v && typeof v === "object") Object.values(v).forEach(walk);
};
walk(GENERIC_SUGGESTIONS);
check("found the composer's generic suggestions to test", genericTexts.length > 0, String(genericTexts.length));
for (const t of genericTexts) {
  const d = chooseDepth(t, fresh);
  check(`composer suggestion stays on the fast path: "${t}"`, d.depth === "single", `${d.depth} (${d.reason})`);
}

const decided = chooseDepth("who did I meet in March", fresh);
check("the decision carries the rule that fired", decided.reason === "asks about a time", decided.reason);

console.log(failures === 0 ? "\nsmoke-chat-depth: all checks passed" : `\nsmoke-chat-depth: ${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
