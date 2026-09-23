/**
 * The import queue's reducer — order, serialisation, and what a failure does to the rest.
 *
 * The rules under test are the ones that would otherwise only show up in a real multi-file
 * drop: connections must run before messages or the messages preview deduplicates backwards;
 * a broken step must not take the remaining files down with it; and "step 2 of 3" must never
 * count a step that was already skipped.
 *
 * Pure tier: no database, no DOM.
 *
 * Run: npx tsx scripts/smoke-import-queue.ts
 */
import {
  advance,
  finishedImportIds,
  isTerminal,
  nextRunnable,
  queueFromDetection,
  stopAll,
  summarize,
  summaryMessage,
  TARGET_LABEL,
  TARGET_LABEL_INLINE,
  unfinishedLine,
  unfinishedSteps,
  type QueuedImport,
} from "../src/lib/imports/import-queue";
import { joinList } from "../src/lib/imports/join-list";
import {
  RUN_ORDER,
  type Detected,
  type ImportTarget,
} from "../src/lib/imports/detect-import-file";
import { failureText } from "../src/lib/errors";

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(
    `  ${ok ? "ok  " : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`,
  );
  if (!ok) failures++;
}

function detected(target: ImportTarget, name: string, bytes = 100): Detected {
  return {
    file: new File(["x".repeat(bytes)], name),
    path: "",
    target,
    confidence: "certain",
    reason: "test",
    bytes,
    displayName: name,
  };
}

function reviewed(items: QueuedImport[]): QueuedImport[] {
  return items.map((i) => ({
    ...i,
    status: "needs_review" as const,
    ids: ["a", "b"],
  }));
}

console.log("Building the queue");
const built = queueFromDetection([
  detected("calendar_ics", "work.ics"),
  detected("linkedin_messages", "messages.csv"),
  detected("linkedin_connections", "Connections.csv"),
]);
check(
  "run order is applied, not drop order",
  built.map((i) => i.target).join(",") ===
    "linkedin_connections,linkedin_messages,calendar_ics",
  built.map((i) => i.target).join(","),
);
check(
  "every item starts waiting",
  built.every((i) => i.status === "waiting"),
);
check("ids are unique", new Set(built.map((i) => i.id)).size === built.length);
check(
  "every runnable target has a label, on the card and in a sentence",
  RUN_ORDER.every(
    (t) =>
      Boolean(TARGET_LABEL[t as Exclude<ImportTarget, "unknown">]) &&
      Boolean(TARGET_LABEL_INLINE[t as Exclude<ImportTarget, "unknown">]),
  ),
);
check(
  "LinkedIn keeps its capital inside a sentence",
  Object.values(TARGET_LABEL_INLINE).every((l) => !l.includes("linkedin")),
);
check(
  "a ZIP member is named by its member, not the archive",
  queueFromDetection([
    {
      ...detected("linkedin_connections", "archive.zip"),
      path: "Basic/Connections.csv",
      displayName: "Connections.csv",
    },
  ])[0].fileName === "Connections.csv",
);
check(
  "a file inside a dropped FOLDER is named by the file, not the folder",
  queueFromDetection([
    {
      ...detected("linkedin_connections", "Connections.csv"),
      path: "Basic_LinkedInDataExport_01-01-2024",
    },
  ])[0].fileName === "Connections.csv",
);

console.log("Serialising the run");
let items = reviewed(built);
const first = nextRunnable(items);
check(
  "the first runnable is the first in run order",
  first?.target === "linkedin_connections",
);

items = advance(items, first!.id, { status: "running" });
check(
  "nothing else may start while one is running",
  nextRunnable(items) === null,
);

let snap = summarize(items);
check(
  "step is 1 of 3",
  snap.step?.index === 1 && snap.step?.total === 3,
  JSON.stringify(snap.step),
);
check("not done yet", !snap.done);

items = advance(items, first!.id, { status: "done", result: "412 contacts" });
const second = nextRunnable(items);
check("the next step is messages", second?.target === "linkedin_messages");
items = advance(items, second!.id, { status: "running" });
check(
  "step is 2 of 3",
  summarize(items).step?.index === 2 && summarize(items).step?.total === 3,
);

console.log("A failure does not stop the rest");
items = advance(items, second!.id, {
  status: "failed",
  error: "Couldn’t read that file",
});
const third = nextRunnable(items);
check(
  "the queue continues past a failed step",
  third?.target === "calendar_ics",
);
items = advance(items, third!.id, { status: "done" });
snap = summarize(items);
check("the run is done", snap.done);
check("no step is reported once nothing runs", snap.step === null);
check(
  "the summary names only the part that didn’t finish",
  summaryMessage(items) ===
    "Imported your LinkedIn connections and calendar — your LinkedIn messages didn’t finish, so try that file on its own",
  summaryMessage(items),
);

console.log("Stopping");
let stopping = reviewed(
  queueFromDetection([
    detected("linkedin_connections", "Connections.csv"),
    detected("linkedin_messages", "messages.csv"),
    detected("calendar_ics", "work.ics"),
  ]),
);
stopping = advance(stopping, stopping[0].id, {
  status: "done",
  result: "412 contacts",
});
stopping = advance(stopping, stopping[1].id, { status: "running" });
stopping = stopAll(stopping);
check(
  "a running step is left alone for the caller to cancel",
  stopping[1].status === "running",
);
check("everything not started is skipped", stopping[2].status === "skipped");
check("an already-done step keeps its result", stopping[0].status === "done");

stopping = advance(stopping, stopping[1].id, { status: "skipped" });
check(
  "step totals never count a skipped step",
  summarize(stopping).step === null && summarize(stopping).done,
);

const midRun = advance(
  stopAll(
    advance(
      reviewed(
        queueFromDetection([
          detected("linkedin_connections", "Connections.csv"),
          detected("linkedin_messages", "messages.csv"),
        ]),
      ),
      "q0-linkedin_connections",
      { status: "running" },
    ),
  ),
  "q0-linkedin_connections",
  {},
);
check(
  "with one skipped, the running step is 1 of 1",
  summarize(midRun).step?.index === 1 && summarize(midRun).step?.total === 1,
  JSON.stringify(summarize(midRun).step),
);

console.log("Copy");
const allDone = queueFromDetection([
  detected("linkedin_connections", "c.csv"),
]).map((i) => ({
  ...i,
  status: "done" as const,
}));
const messages = [
  summaryMessage(allDone),
  summaryMessage(items),
  summaryMessage(stopping),
  summaryMessage([]),
];
check(
  "no message says “failed”",
  messages.every((m) => !/failed/i.test(m)),
  messages.join(" | "),
);
check(
  "no message says “Could not”",
  messages.every((m) => !/could not/i.test(m)),
);
check(
  "no message ends in a period",
  messages.every((m) => !m.endsWith(".")),
);
check(
  "no message uses a straight apostrophe",
  messages.every((m) => !m.includes("'")),
);

console.log("Contracts");
check(
  "terminal states are exactly done/failed/skipped",
  isTerminal("done") &&
    isTerminal("failed") &&
    isTerminal("skipped") &&
    !isTerminal("waiting") &&
    !isTerminal("running") &&
    !isTerminal("needs_review") &&
    !isTerminal("previewing"),
);
check(
  "an unreviewed item is never runnable",
  nextRunnable(
    queueFromDetection([detected("linkedin_connections", "c.csv")]),
  ) === null,
);
check(
  "a reviewed item with nothing selected is never runnable",
  nextRunnable([
    {
      ...queueFromDetection([detected("linkedin_connections", "c.csv")])[0],
      status: "needs_review",
      ids: [],
    },
  ]) === null,
);
check("an empty queue is not 'done'", !summarize([]).done);

console.log("A failed step's error text");
// `failureText` is what `ImportJobWatcher` and `runQueue` use once a job's failure has been
// flattened to a plain string on the snapshot/queue item — see `src/lib/errors.ts`. A
// message a catch site marked `userFacing: true` (it was `isUserFacingError` at the moment
// of the throw, before that identity was lost) passes through verbatim; anything else still
// goes through `friendlyError`, so a raw driver string never reaches a toast unflattened.
check(
  "user-facing text passes through verbatim",
  failureText("Pick up to 25 files at a time", true, "Import didn’t finish") ===
    "Pick up to 25 files at a time",
);
check(
  "raw driver text is not shown as-is",
  failureText(
    'duplicate key value violates unique constraint "x"',
    false,
    "Import didn’t finish",
  ) !== 'duplicate key value violates unique constraint "x"',
);
check(
  "raw driver text with no flag is treated the same as false",
  failureText(
    'duplicate key value violates unique constraint "x"',
    undefined,
    "Import didn’t finish",
  ) !== 'duplicate key value violates unique constraint "x"',
);
check(
  "an empty message still says something",
  failureText("", true, "Import didn’t finish") === "Import didn’t finish",
);

/**
 * Which imports a run may speak for.
 *
 * The done card is built from these ids, so the cases that must return nothing are the cases
 * where the card must not be drawn at all: a drop of files nothing recognises stages no steps,
 * and a run whose every step broke wrote no import. Before this, the card asked the server for
 * "the newest completed import on the account" and happily celebrated an unrelated one.
 */
console.log("A run only speaks for the imports it wrote");
const ran = (over: Partial<QueuedImport>): QueuedImport => ({
  ...queueFromDetection([detected("linkedin_connections", "c.csv")])[0],
  ...over,
});
check("nothing staged means no ids", finishedImportIds([]).length === 0);
check(
  "every step broken means no ids",
  finishedImportIds([
    ran({ status: "failed", error: "nope" }),
    ran({ id: "q2", status: "failed", error: "nope" }),
  ]).length === 0,
);
check(
  "a step that finished before the id existed is not counted",
  finishedImportIds([ran({ status: "done" })]).length === 0,
);
check(
  "skipped and failed steps are left out",
  finishedImportIds([
    ran({ status: "done", importId: "a" }),
    ran({ id: "q2", status: "skipped", importId: "b" }),
    ran({ id: "q3", status: "failed", importId: "c" }),
    ran({ id: "q4", status: "done", importId: "d" }),
  ]).join(",") === "a,d",
);

/**
 * A stopped run leaves a trace.
 *
 * Stopping a three-file drop after the first file used to end on a pure celebration of that
 * file: the step in flight is reported `done` by the runner (its rows were kept), the rest are
 * `skipped`, the in-flight import is `cancelled` so the server never returns it — and the done
 * card rendered only failed steps, of which there were none. Every step Stop ended now says so.
 */
console.log("A stopped run leaves a trace");
let halted = reviewed(
  queueFromDetection([
    detected("linkedin_connections", "Connections.csv"),
    detected("linkedin_messages", "messages.csv"),
    detected("calendar_ics", "work.ics"),
  ]),
);
halted = advance(halted, halted[0].id, { status: "done", importId: "a" });
halted = advance(halted, halted[1].id, { status: "running" });
halted = stopAll(halted);
check(
  "a step Stop skipped is marked as stopped",
  halted[2].status === "skipped" && halted[2].stopped === true,
);
check("a step that finished is not", !halted[0].stopped);
check("the step in flight is left for the runner to report", !halted[1].stopped);
// What `runQueue` writes when the runner comes back `cancelled`: its rows were kept, so the
// step is done — but it was stopped, and its import is not a finished one.
halted = advance(halted, halted[1].id, {
  status: "done",
  importId: "b",
  stopped: true,
});
check(
  "a stopped step's import is not the run's to celebrate",
  finishedImportIds(halted).join(",") === "a",
  finishedImportIds(halted).join(","),
);
check(
  "both stopped steps are unfinished, the finished one is not",
  unfinishedSteps(halted).map((i) => i.id).join(",") ===
    [halted[1].id, halted[2].id].join(","),
  unfinishedSteps(halted).map((i) => i.id).join(","),
);
check(
  "the card's lead line says the run was stopped",
  unfinishedLine(halted) ===
    "You stopped the import before your LinkedIn messages and calendar finished",
  String(unfinishedLine(halted)),
);

check(
  "the toast does not claim the stopped step was imported",
  summaryMessage(halted) === "Imported your LinkedIn connections — the rest was stopped",
  summaryMessage(halted),
);

const stoppedFirst = stopAll(
  advance(
    reviewed(queueFromDetection([detected("linkedin_connections", "c.csv")])),
    "q0-linkedin_connections",
    { status: "done", importId: "a", stopped: true },
  ),
);
check(
  "stopped during the first step is not “nothing was imported”",
  summaryMessage(stoppedFirst) === "Import stopped",
  summaryMessage(stoppedFirst),
);

const choseToSkip = advance(
  reviewed(queueFromDetection([detected("linkedin_connections", "c.csv")])),
  "q0-linkedin_connections",
  { status: "skipped" },
);
check(
  "a file the person chose not to import is not unfinished",
  unfinishedSteps(choseToSkip).length === 0 &&
    unfinishedLine(choseToSkip) === undefined,
);
const oneDoneOneDeclined = advance(
  advance(
    reviewed(
      queueFromDetection([
        detected("linkedin_connections", "Connections.csv"),
        detected("calendar_ics", "work.ics"),
      ]),
    ),
    "q0-linkedin_connections",
    { status: "done", importId: "a" },
  ),
  "q1-calendar_ics",
  { status: "skipped" },
);
check(
  "…and the toast does not call it stopped",
  summaryMessage(oneDoneOneDeclined) === "Imported your LinkedIn connections",
  summaryMessage(oneDoneOneDeclined),
);

let brokeThenStopped = reviewed(
  queueFromDetection([
    detected("contacts_file", "contacts.vcf"),
    detected("linkedin_connections", "Connections.csv"),
    detected("calendar_ics", "work.ics"),
  ]),
);
brokeThenStopped = advance(brokeThenStopped, brokeThenStopped[0].id, {
  status: "done",
  importId: "a",
});
brokeThenStopped = advance(brokeThenStopped, brokeThenStopped[1].id, {
  status: "failed",
  error: "Couldn’t read that file",
});
brokeThenStopped = stopAll(brokeThenStopped);
check(
  "a failure and a stop are both said, in one line",
  unfinishedLine(brokeThenStopped) ===
    `Your ${TARGET_LABEL_INLINE[brokeThenStopped[1].target as "linkedin_connections"]} didn’t finish — you stopped the rest`,
  String(unfinishedLine(brokeThenStopped)),
);

const threeBroke = reviewed(
  queueFromDetection([
    detected("linkedin_connections", "Connections.csv"),
    detected("linkedin_messages", "messages.csv"),
    detected("calendar_ics", "work.ics"),
  ]),
).map((i) => ({ ...i, status: "failed" as const, error: "nope" }));
check(
  "three names read as a list, not a chain of “and”",
  unfinishedLine(threeBroke) ===
    "Your LinkedIn connections, LinkedIn messages and calendar didn’t finish",
  String(unfinishedLine(threeBroke)),
);
check("nothing unfinished means no line", unfinishedLine(allDone) === undefined);
for (const line of [unfinishedLine(halted), unfinishedLine(brokeThenStopped), unfinishedLine(threeBroke)]) {
  check(
    `house voice: ${String(line).slice(0, 40)}`,
    Boolean(line) &&
      !/\bfailed\b/i.test(line!) &&
      !line!.endsWith(".") &&
      !line!.includes("'") &&
      (line!.match(/ — /g) ?? []).length <= 1,
    String(line),
  );
}

console.log("One way to join a list");
check("one", joinList(["A"]) === "A");
check("two", joinList(["A", "B"]) === "A and B");
check("three", joinList(["A", "B", "C"]) === "A, B and C", joinList(["A", "B", "C"]));
check("none", joinList([]) === "");

if (failures) {
  console.error(`\n${failures} queue check${failures === 1 ? "" : "s"} failed`);
  process.exit(1);
}
console.log("\nimport queue smoke tests passed");
process.exit(0);
