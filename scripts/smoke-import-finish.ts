/**
 * What the done card says. The arithmetic has to agree with the history chips and the People
 * list — they disagreed once already (the engine counts a merged person under two counters),
 * and a third place to get it wrong is exactly how that comes back.
 *
 * Run: npx tsx scripts/smoke-import-finish.ts
 */
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  finishCopy,
  mergeFinishSummaries,
  undoDismissLabel,
  type FinishSummary,
} from "../src/lib/imports/import-finish";
import { IMPORT_COPY } from "../src/lib/imports/import-copy";
import { ImportFinishCard } from "../src/components/imports/import-finish-card";

let failures = 0;
function check(label: string, ok: boolean, detail?: string) {
  if (ok) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.error(`  FAIL ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

const base: FinishSummary = {
  importIds: ["i1"],
  added: 19,
  existing: 6,
  meetingsLogged: 0,
  sources: ["Connections.csv"],
};

const normal = finishCopy(base);
check("counts the new people", normal.headline.includes("19"));
check("names the ones already here", (normal.detail ?? "").includes("6"));
check("the button goes to this import's people", "href" in normal.action && normal.action.href === "/contacts?importId=i1");
check("the button names the number", normal.action.label.includes("19"));
// The list the button opens holds the people the run ADDED and nobody it matched, so the label
// says "new" — the spec's own word, and the one that keeps the promise the right size.
check("…and says they are new", normal.action.label === "Meet your 19 new people", normal.action.label);

const one = finishCopy({ ...base, added: 1, existing: 0 });
check("one person reads as a person", one.headline.includes("1 person") && !one.headline.includes("1 people"));
check("nobody already here means no second line", one.detail === null);
check("one new person reads as one", one.action.label === "Meet your 1 new person", one.action.label);

const nobodyNew = finishCopy({ ...base, added: 0, existing: 25 });
check("nobody new is not a lie", !nobodyNew.headline.includes("0 people"));
check("…and the button changes", "kind" in nobodyNew.action && nobodyNew.action.kind === "detail");

const calendar = finishCopy({ ...base, added: 0, existing: 0, meetingsLogged: 38, sources: ["work.ics"] });
check("a calendar import reports meetings", calendar.headline.includes("38"));
check("…and does not claim people", !calendar.headline.includes("0"));

const several = finishCopy({ ...base, sources: ["Connections.csv", "messages.csv"] });
check("several files are named", (several.detail ?? "").includes("Connections.csv") && (several.detail ?? "").includes("messages.csv"));
const three = finishCopy({ ...base, sources: ["a.csv", "b.csv", "c.vcf"] });
check(
  "three files read as a list",
  (three.detail ?? "").endsWith("From a.csv, b.csv and c.vcf"),
  String(three.detail),
);

const oneAlreadyHere = finishCopy({ ...base, added: 4, existing: 1 });
check(
  "one person already here takes a singular verb",
  (oneAlreadyHere.detail ?? "").startsWith("1 person was already in your orbit"),
  String(oneAlreadyHere.detail),
);
check(
  "…and several still take the plural",
  (normal.detail ?? "").startsWith("6 people were already in your orbit"),
  String(normal.detail),
);

/**
 * One drop is one card.
 *
 * Each file in a queued run writes its own `imports` row, so the card's arithmetic is a sum
 * over those rows and not a reading of any one of them. This is also the guard against the
 * card speaking for a run it had nothing to do with: a run that finished no imports has no
 * summary at all, so there is nothing to render.
 */
console.log("A run of several files is one summary");
const connections: FinishSummary = {
  importIds: ["a"],
  added: 19,
  existing: 6,
  meetingsLogged: 0,
  sources: ["Connections.csv"],
};
const messages: FinishSummary = {
  importIds: ["b"],
  added: 4,
  existing: 11,
  meetingsLogged: 38,
  sources: ["messages.csv"],
};
const run = mergeFinishSummaries([connections, messages]);
check("nothing finished means no card at all", mergeFinishSummaries([]) === null);
check("the people add up", run?.added === 23 && run?.existing === 17);
check("so do the meetings", run?.meetingsLogged === 38);
check("every import in the run is carried", run?.importIds.join(",") === "a,b");
check("both files are named", run?.sources.join("|") === "Connections.csv|messages.csv");
check("a single file is still just itself", mergeFinishSummaries([connections])?.importIds.join(",") === "a");

const runCopy = finishCopy(run!);
check("the run's button counts everyone it added", runCopy.action.label.includes("23"));
check(
  "…and points at every import in it",
  "href" in runCopy.action && runCopy.action.href === "/contacts?importId=a,b",
);
check("…and the detail names both files", (runCopy.detail ?? "").includes("Connections.csv") && (runCopy.detail ?? "").includes("messages.csv"));

const halfDone = mergeFinishSummaries([connections], "Your LinkedIn messages didn’t finish");
check("a step that didn’t land leads the card", halfDone?.unfinished === "Your LinkedIn messages didn’t finish");

const partial = finishCopy({ ...base, unfinished: "LinkedIn messages didn’t finish" });
check("an unfinished step leads", partial.headline.includes("didn’t finish"));
check("…and still offers the people that landed", "href" in partial.action);

/**
 * What the run could not bring in.
 *
 * A step can finish and still leave people behind: the plan's contact cap refuses the tail of
 * a big import (`blockedByPlan`, an upgrade rather than a fault), and chunk narrowing drops rows
 * the database refused (`failedRows` — the runner's own comment calls its completion line "the
 * only place a user is told"). The done card replaced that line, so the card has to say both.
 */
console.log("What the run could not bring in is on the card");
const capped = finishCopy({ ...base, blockedByPlan: 40 });
check(
  "the plan cap is named, as a way to upgrade",
  capped.notices.some(
    (n) =>
      n.text === "40 more are waiting on your plan" &&
      n.href === "/settings?section=settings-plan" &&
      n.tone === "offer",
  ),
  JSON.stringify(capped.notices),
);
const refusedRows = finishCopy({ ...base, failedRows: 3 });
check(
  "rows the database refused are named",
  refusedRows.notices.some((n) => n.text === "3 rows Orbit couldn’t save" && !n.href),
  JSON.stringify(refusedRows.notices),
);
check(
  "one of each reads as one",
  finishCopy({ ...base, blockedByPlan: 1, failedRows: 1 }).notices.map((n) => n.text).join("|") ===
    "1 more is waiting on your plan|1 row Orbit couldn’t save",
);
check("a clean run says neither", normal.notices.length === 0);
const leftBehind = mergeFinishSummaries([
  { ...connections, blockedByPlan: 10, failedRows: 1 },
  { ...messages, failedRows: 2 },
]);
check(
  "they add up across a run",
  leftBehind?.blockedByPlan === 10 && leftBehind?.failedRows === 3,
  JSON.stringify(leftBehind),
);

for (const copy of [normal, one, nobodyNew, calendar, several, partial, capped, refusedRows]) {
  const lines = [copy.headline, copy.detail ?? "", copy.action.label, ...copy.notices.map((n) => n.text)];
  for (const line of lines) {
    check(`house voice: ${line.slice(0, 40)}`, !/\bfailed\b/i.test(line) && !line.endsWith(".") && !line.includes("'") && (line.match(/ — /g) ?? []).length <= 1, line);
  }
}

/**
 * No swarm over bad news (spec §1: "If any step didn't finish… the scene is not drawn").
 *
 * The guard is one ternary in the card, which is exactly the kind of line a later edit
 * reinstates without noticing: a field of people settling into orbit under "your messages
 * didn't finish" is the card celebrating anyway.
 */
console.log("The scene knows when not to play");
const cardHtml = (summary: FinishSummary) =>
  renderToStaticMarkup(
    React.createElement(ImportFinishCard, { summary, avatars: [] }),
  );
check("a clean finish draws the swarm", cardHtml(base).includes("<canvas"));
check(
  "a step that didn’t finish does not",
  !cardHtml({ ...base, unfinished: "Your LinkedIn messages didn’t finish" }).includes("<canvas"),
);
check(
  "…and says so instead",
  cardHtml({ ...base, unfinished: "Your LinkedIn messages didn’t finish" }).includes(
    "didn’t finish",
  ),
);

/**
 * The announcement lives in the queue card, not here.
 *
 * A `role="status"` node that mounts with its text already inside is the one case screen
 * readers do NOT reliably announce; the queue card keeps an empty region alive across the
 * running → done transition and sets the sentence into it. A second, pre-filled status node
 * on the card itself would be the old bug back, and a double announcement where it did work.
 */
console.log("The card leaves the announcement to the region that outlives it");
check("the card carries no status region of its own", !cardHtml(base).includes('role="status"'));
check(
  "the card links the plan cap",
  cardHtml({ ...base, blockedByPlan: 40 }).includes("/settings?section=settings-plan") &&
    cardHtml({ ...base, blockedByPlan: 40 }).includes("40 more are waiting on your plan"),
);
check(
  "…and names the refused rows",
  cardHtml({ ...base, failedRows: 3 }).includes("3 rows Orbit couldn’t save"),
);

/**
 * The dialog's secondary button while people are being taken out.
 *
 * "Keep them" there is a lie at the destructive moment: clicking it only hides the dialog while
 * the removal carries on. During removal the button says what it actually does.
 */
console.log("The undo dialog's buttons say what they do");
check(
  "while removing, the button does not offer to keep them",
  undoDismissLabel("removing", true) === IMPORT_COPY.undoDismiss &&
    undoDismissLabel("removing", true) !== IMPORT_COPY.undoCancel,
  undoDismissLabel("removing", true),
);
check("before confirming, it is still the way out", undoDismissLabel("ready", true) === IMPORT_COPY.undoCancel);
check("with nothing to remove, it only closes", undoDismissLabel("ready", false) === IMPORT_COPY.undoClose);
check("while checking, it only closes", undoDismissLabel("checking", false) === IMPORT_COPY.undoClose);

if (failures) {
  console.error(`smoke-import-finish: ${failures} failed`);
  process.exit(1);
}
console.log("smoke-import-finish: all checks passed");
process.exit(0);