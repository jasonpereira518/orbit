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
  isTerminal,
  nextRunnable,
  queueFromDetection,
  stopAll,
  summarize,
  summaryMessage,
  TARGET_LABEL,
  TARGET_LABEL_INLINE,
  type QueuedImport,
} from "../src/lib/imports/import-queue";
import {
  RUN_ORDER,
  type Detected,
  type ImportTarget,
} from "../src/lib/imports/detect-import-file";

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

if (failures) {
  console.error(`\n${failures} queue check${failures === 1 ? "" : "s"} failed`);
  process.exit(1);
}
console.log("\nimport queue smoke tests passed");
process.exit(0);
