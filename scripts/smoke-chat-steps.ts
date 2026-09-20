/**
 * Pins the chat activity narration in `src/lib/chat-steps.ts`.
 *
 * The whole value of the feature is that a step describes work that really ran, so these
 * checks are mostly about what must NOT happen: a stage that never started must not appear,
 * a completion must find its own step rather than whichever one finished last, and a
 * follow-up must never name someone retrieval did not return.
 *
 * Pure: no network, no database. Run: npx tsx scripts/smoke-chat-steps.ts
 */
import {
  createStepEmitter,
  deriveFollowUps,
  describeArms,
  NULL_STEPS,
  plural,
  toRefs,
} from "../src/lib/chat-steps";
import type { ChatStep } from "../src/lib/chat-stream-protocol";

let failures = 0;
function check(label: string, ok: boolean, detail?: string) {
  if (ok) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.error(`  FAIL ${label}${detail ? `\n       ${detail}` : ""}`);
  }
}

function collect() {
  const seen: ChatStep[] = [];
  return { seen, emitter: createStepEmitter((step) => seen.push({ ...step })) };
}

console.log("The emitter reports stages as they run...");
{
  const { seen, emitter } = collect();
  emitter.start("search", "Searching your network");
  emitter.done("search", { label: "Searched 412 contacts" });
  check("a stage emits once on start and once on done", seen.length === 2);
  check("the start is marked active", seen[0]?.status === "active");
  check("the done is marked done", seen[1]?.status === "done");
  check("the done carries the updated label", seen[1]?.label === "Searched 412 contacts");
  check("a finished stage has a real duration", typeof seen[1]?.ms === "number");
  check("the step id is stable across start and done", seen[0]?.id === seen[1]?.id);
}

console.log("\nOut-of-order completion — the parallel fan-out's actual behaviour");
{
  const { seen, emitter } = collect();
  emitter.start("search", "Searching");
  emitter.start("attention", "Checking overdue");
  emitter.start("recruiters", "Checking recruiters");
  // Finishing in a different order than they started is the normal case: these three run
  // inside one Promise.all. A stack would mis-assign every one of these.
  emitter.done("recruiters", { label: "Checked 3 recruiters" });
  emitter.done("search", { label: "Searched 412 contacts" });
  emitter.done("attention", { label: "Checked 6 overdue follow-ups" });

  const byKind = new Map(emitter.snapshot().map((s) => [s.kind, s]));
  check("each done updates its own stage", byKind.get("search")?.label === "Searched 412 contacts");
  check("a late finisher is not mis-assigned", byKind.get("recruiters")?.label === "Checked 3 recruiters");
  check("attention keeps its own label", byKind.get("attention")?.label === "Checked 6 overdue follow-ups");
  check("every stage ends up done", emitter.snapshot().every((s) => s.status === "done"));
  check("six events for three stages", seen.length === 6);
}

console.log("\nThe snapshot is what gets persisted");
{
  const { emitter } = collect();
  emitter.start("understand", "Working it out");
  emitter.done("understand", { label: "Worked it out" });
  emitter.start("search", "Searching");
  emitter.done("search", { label: "Searched" });
  const snap = emitter.snapshot();
  check("one entry per stage, not one per event", snap.length === 2);
  check("start order is preserved", snap[0]?.kind === "understand" && snap[1]?.kind === "search");
}

console.log("\nA stage that never ran is never reported");
{
  const { seen, emitter } = collect();
  emitter.start("search", "Searching");
  emitter.done("search", { label: "Searched" });
  const kinds = seen.map((s) => s.kind);
  check("no roster step when no org was named", !kinds.includes("roster"));
  check("no attention step for a question that did not ask", !kinds.includes("attention"));
  check("no verify step when nothing was filtered", !kinds.includes("verify"));
  check("the snapshot has no skipped placeholders", emitter.snapshot().length === 1);
}

console.log("\nA bare done still reports rather than vanishing");
{
  const { seen, emitter } = collect();
  emitter.done("roster", { label: "You know 24 people at AWS" });
  check("a done with no start still emits", seen.length === 1);
  check("it is marked done", seen[0]?.status === "done");
  check("it has no invented duration", seen[0]?.ms === undefined);
  check("it reaches the snapshot", emitter.snapshot().length === 1);
}

console.log("\nThe null emitter is inert");
{
  NULL_STEPS.start("search", "Searching");
  NULL_STEPS.done("search");
  check("the null emitter records nothing", NULL_STEPS.snapshot().length === 0);
}

console.log("\nLabel helpers");
{
  check("singular", plural(1, "contact") === "1 contact");
  check("plural", plural(2, "contact") === "2 contacts");
  check("zero is plural", plural(0, "contact") === "0 contacts");
  check("an explicit plural is used", plural(2, "person", "people") === "2 people");
  check("large counts are grouped", plural(1234, "contact").startsWith("1,234"));

  check("arms are named in human terms", describeArms(["fts", "semantic"]) === "name and notes, meaning");
  check("duplicate arms collapse", describeArms(["fts", "fts"]) === "name and notes");
  check("no arms means no detail line", describeArms([]) === undefined);
  check("an unknown arm is ignored rather than leaked", describeArms(["wat"]) === undefined);

  check("no refs for an empty list", toRefs([], "contact") === undefined);
  const refs = toRefs([{ id: "a", name: "Ada" }, { id: "b", name: "Ben" }], "contact");
  check("refs carry id, name and kind", refs?.[0]?.id === "a" && refs?.[0]?.kind === "contact");
  const many = toRefs(
    Array.from({ length: 30 }, (_, i) => ({ id: String(i), name: `P${i}` })),
    "contact"
  );
  check("refs are capped", (many?.length ?? 0) === 8);
}

console.log("\nFollow-ups are derived, never invented");
{
  const none = deriveFollowUps({ question: "who do I know?" });
  check("nothing retrieved means no follow-ups", none.length === 0);

  const full = deriveFollowUps({
    question: "who do I know at Ramp?",
    topRosterCompany: "Ramp",
    firstOverdueName: "Ada Lovelace",
    topContactName: "Ben Shaw",
  });
  check("a roster becomes a follow-up", full.includes("Who else do I know at Ramp?"));
  check("an overdue person becomes a follow-up", full.includes("Draft a note to Ada Lovelace"));
  check("the top match becomes a follow-up", full.includes("Tell me more about Ben Shaw"));
  check("capped at three", full.length === 3);

  const echo = deriveFollowUps({
    question: "Who else do I know at Ramp?",
    topRosterCompany: "Ramp",
    topContactName: "Ben Shaw",
  });
  check("a follow-up never repeats the question asked", !echo.includes("Who else do I know at Ramp?"));

  const dupes = deriveFollowUps({
    question: "hello",
    topRosterCompany: "Ramp",
    firstOverdueName: "Ada",
    topContactName: "Ada",
  });
  check("no duplicate follow-ups", new Set(dupes).size === dupes.length);

  const limited = deriveFollowUps(
    { question: "hi", topRosterCompany: "Ramp", firstOverdueName: "Ada", topContactName: "Ben" },
    2
  );
  check("the cap is honoured", limited.length === 2);
}

if (failures) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nAll chat step checks passed");
process.exit(0);
