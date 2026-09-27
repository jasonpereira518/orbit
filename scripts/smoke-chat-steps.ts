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
import { ORBIT_FACE, ORBIT_RINGS, ORBIT_SIZE, minFaceSeparation } from "../src/lib/chat-orbit-geometry";
import { collectOrbitPeople, ORBIT_CAPACITY } from "../src/lib/chat-orbit-people";
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


console.log("\nupdate() enriches a finished stage without re-stamping it");
{
  const { seen, emitter } = collect();
  emitter.start("rank", "Ranking");
  emitter.done("rank", { label: "Kept 2", refs: [{ id: "a", name: "Ada", kind: "contact" }] });
  const done = seen[seen.length - 1];
  emitter.update("rank", { refs: [{ id: "a", name: "Ada", kind: "contact", photoUrl: "/api/avatars/a" }] });
  const after = seen[seen.length - 1];
  check("an update re-sends the stage", seen.length === 3);
  check("it carries the new detail", after?.refs?.[0]?.photoUrl === "/api/avatars/a");
  check("status is untouched", after?.status === "done");
  check("duration is untouched", after?.ms === done?.ms);
  check("label is untouched", after?.label === "Kept 2");

  const { seen: none, emitter: fresh } = collect();
  fresh.update("search", { label: "Nothing to update" });
  check("a stage that never reported is not invented by an update", none.length === 0 && fresh.snapshot().length === 0);

  const boom = createStepEmitter(() => {
    throw new Error("stream closed");
  });
  let threw = false;
  try {
    // start/done go through the caller's stream directly and may throw; update runs detached
    // after the stream can have closed, so it must not.
    try {
      boom.start("rank", "x");
    } catch {}
    boom.update("rank", { label: "y" });
  } catch {
    threw = true;
  }
  check("update swallows a closed stream", !threw);
}

console.log("\nWho circles the planet");
{
  const contact = (id: string, photoUrl?: string) => ({ id, name: `Person ${id}`, kind: "contact" as const, photoUrl });
  const step = (kind: ChatStep["kind"], status: ChatStep["status"], refs?: ChatStep["refs"]): ChatStep => ({
    id: kind,
    kind,
    label: kind,
    status,
    refs,
  });

  check("no steps, no one", collectOrbitPeople([]).length === 0);

  const searching = [step("search", "done", [contact("a"), contact("b"), contact("c")]), step("rank", "active")];
  check("candidates are shown while the rerank is still running", collectOrbitPeople(searching).map((p) => p.id).join() === "a,b,c");

  const ranked = [...searching.slice(0, 1), step("rank", "done", [contact("b")])];
  check("once ranked, candidates give way to the survivors", collectOrbitPeople(ranked).map((p) => p.id).join() === "b");

  const named = [step("attached", "done", [contact("n")]), step("search", "done", [contact("a")]), step("rank", "done", [contact("b")])];
  check("people you named stay through the rerank", collectOrbitPeople(named).map((p) => p.id).join() === "n,b");

  const dupes = [step("rank", "done", [contact("a")]), step("read", "done", [contact("a"), contact("b")])];
  check("a person two stages report appears once", collectOrbitPeople(dupes).map((p) => p.id).join() === "a,b");

  const photoLater = [step("rank", "done", [contact("a")]), step("read", "done", [contact("a", "/api/avatars/a")])];
  check("a photo learned by any stage is kept", collectOrbitPeople(photoLater)[0]?.photoUrl === "/api/avatars/a");

  const orgs = [step("roster", "done", [{ id: "Acme", name: "Acme", kind: "org" }]), step("recruiters", "done", [{ id: "r", name: "Rec", kind: "recruiter" }])];
  check("organisations and recruiters do not orbit as contacts", collectOrbitPeople(orgs).length === 0);

  const crowd = [step("rank", "done", Array.from({ length: 30 }, (_, i) => contact(String(i))))];
  check("the scene is capped so faces never crowd", collectOrbitPeople(crowd).length === ORBIT_CAPACITY);
  check("the cap keeps the strongest, in rank order", collectOrbitPeople(crowd)[0]?.id === "0");

  check("a missing photo is null, not undefined", collectOrbitPeople([step("rank", "done", [contact("a")])])[0]?.photoUrl === null);
}

console.log("\nOrbit geometry: faces never touch");
{
  const capacity = ORBIT_RINGS.reduce((n, r) => n + r.capacity, 0);
  check("the rings hold exactly what the scene is capped at", capacity === ORBIT_CAPACITY, `${capacity} vs ${ORBIT_CAPACITY}`);
  check("no two faces can ever be closer than a face is wide", minFaceSeparation() >= ORBIT_FACE, `${minFaceSeparation().toFixed(1)}px vs ${ORBIT_FACE}px`);
  // The counter-rotating rings line up on every pass, so the radial gap alone must clear a face.
  const [inner, outer] = ORBIT_RINGS;
  check("the gap between the rings clears a face", Math.abs(outer.radius - inner.radius) >= ORBIT_FACE);
  check("the scene is big enough to hold the outermost face", ORBIT_SIZE / 2 >= outer.radius + ORBIT_FACE / 2);
  // Guards the guard: the arrangement that shipped first must fail it.
  const cramped = [
    { ...inner, radius: 40 },
    { ...outer, radius: 60 },
  ];
  check("the original 20px gap is caught as overlapping", minFaceSeparation(cramped) < 28);
  // Twelve faces round the inner ring sit ~18px apart on a 26px face: the guard must object.
  check("a ring too crowded for its faces is caught", minFaceSeparation([{ ...inner, capacity: 12 }]) < ORBIT_FACE);
  check("and a sparse ring is not falsely flagged", minFaceSeparation([{ ...outer, capacity: 5 }]) >= ORBIT_FACE);
}

if (failures) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nAll chat step checks passed");
process.exit(0);
