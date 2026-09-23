/**
 * The import history row, rendered — and the guarantee that no raw error reaches it.
 *
 * `imports.error_message` holds whatever the driver threw: Postgres constraint prose, OAuth
 * token-endpoint bodies, socket errors. The row used to print that verbatim. The mapping is
 * unit-tested next door, but the mapping being right is not the same as the component using
 * it — a single `{h.errorMessage}` slipping back in would restore the bug with every unit test
 * still green. This renders the real component and greps the output.
 *
 * It also pins the counter semantics that differ per import type: a calendar import runs with
 * `createsContacts: false`, so "0 created · 0 updated" is a true sentence about the wrong
 * thing, and `blockedByPlan` is an upgrade prompt rather than a fault.
 *
 * Pure tier: no database.
 *
 * Run: npx tsx scripts/smoke-import-history-render.ts
 */
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  ImportDetailBody,
  ImportHistory,
  formatFlagDue,
} from "../src/components/imports/import-history";
import { Sheet } from "../src/components/ui/sheet";
import type { ImportDetail, ImportHistoryItem } from "../src/actions/imports";

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(
    `  ${ok ? "ok  " : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`,
  );
  if (!ok) failures++;
}

function item(over: Partial<ImportHistoryItem> = {}): ImportHistoryItem {
  return {
    id: "i1",
    importType: "linkedin_connections",
    fileName: "Connections.csv",
    status: "completed",
    totalRows: 100,
    rowsProcessed: 100,
    contactsCreated: 12,
    contactsUpdated: 3,
    duplicatesFound: 2,
    errorMessage: null,
    createdAt: new Date("2026-09-01T10:00:00Z"),
    stats: {},
    ...over,
  };
}

const render = (items: ImportHistoryItem[]) =>
  renderToStaticMarkup(React.createElement(ImportHistory, { history: items }));

console.log("A normal import");
const ok = render([item()]);
check("names the file", ok.includes("Connections.csv"));
check("names the source", ok.includes("LinkedIn connections"));
check(
  "counts what came in",
  ok.includes("12 added") && ok.includes("3 updated"),
);

console.log("Merged people are counted once");
// The engine bumps contactsUpdated and duplicatesFound together for every merge, so the same
// two people must not read as "2 updated · 2 already here".
const merged = render([item({ contactsCreated: 1, contactsUpdated: 2, duplicatesFound: 2 })]);
check("one chip for the merged people", merged.includes("2 already in Orbit"));
check("no second count of them", !merged.includes("2 updated") && !merged.includes("2 already here"));

console.log("Raw errors never reach the page");
/** Verbatim text real failures put in `imports.error_message`. */
const RAW = [
  'duplicate key value violates unique constraint "contacts_user_email_uidx"',
  '{"error":"invalid_grant","error_description":"Token has been expired or revoked."}',
  "canceling statement due to statement timeout",
  "connect ECONNRESET 10.0.0.1:5432",
  "value too long for type character varying(255)",
  "Request failed with status code 401 (ref ab12cd34)",
];
for (const raw of RAW) {
  const html = render([item({ status: "failed", errorMessage: raw })]);
  const leaked = [
    "unique constraint",
    "invalid_grant",
    "error_description",
    "canceling statement",
    "ECONNRESET",
    "character varying",
    "10.0.0.1",
  ].filter((frag) => html.includes(frag));
  check(
    `${raw.slice(0, 42)}… is mapped`,
    leaked.length === 0,
    leaked.join(", "),
  );
}

const failedHtml = render([
  item({
    status: "failed",
    errorMessage: 'duplicate key value violates unique constraint "x"',
  }),
]);
check(
  "...and says something useful instead",
  failedHtml.includes("Some rows clashed"),
  "",
);
check(
  "...with a next step",
  failedHtml.includes("Everything else was imported"),
);

console.log("A stored code beats classifying the text");
const coded = render([
  item({
    status: "failed",
    errorMessage: "something nobody can classify",
    stats: { errorCode: "needs_reconnect" },
  }),
]);
check(
  "the precise code wins",
  coded.includes("connection to that account expired"),
  "",
);

console.log("Counters mean what they say");
const calendar = render([
  item({
    id: "c1",
    importType: "calendar_ics",
    fileName: "work.ics",
    contactsCreated: 0,
    contactsUpdated: 0,
    duplicatesFound: 0,
    stats: { interactionsLogged: 8 },
  }),
]);
check(
  "a calendar import reports meetings",
  calendar.includes("8 meetings logged"),
);
check(
  "...and never claims 0 created",
  !calendar.includes("0 added") && !calendar.includes("0 updated"),
);

const capped = render([item({ stats: { blockedByPlan: 40 } })]);
check("the plan cap is named", capped.includes("40 waiting on your plan"));
check("...as an upgrade, not a fault", capped.includes("settings-plan"));
check("...and not in red", !/destructive[^"]*"[^"]*40 waiting/.test(capped));

const refused = render([item({ stats: { failedRows: 3, skipped: 5 } })]);
check(
  "rows the database refused are named",
  refused.includes("3 Orbit couldn’t save"),
);
check("...separately from skipped ones", refused.includes("5 skipped"));
check("...and never with the word “failed”", !/\bfailed\b/i.test(refused), "");

console.log("An undone import says so");
const undone = render([
  item({
    contactsCreated: 19,
    contactsUpdated: 6,
    duplicatesFound: 6,
    stats: {
      undoneAt: "2026-09-22T12:00:00Z",
      undoneRemoved: 17,
      undoneKept: 2,
    },
  }),
]);
check("the row says it was undone", undone.includes("Undone"));
// Not a bare `includes("17")`: lucide's own SVG path data carries "17", so that check passes
// on a row that says nothing at all.
check("…and how many went", undone.includes("17 people removed"));
check("…and never with the word “failed”", !/\bfailed\b/i.test(undone));
// The chips describe what the import brought in. Once it has been undone they describe
// people who are no longer here, so the row must not go on claiming them.
check(
  "…and stops claiming the people it brought in",
  !undone.includes("19 added"),
);

/**
 * An undo that has started but not finished.
 *
 * `undoneAt` is written only once the whole removal is done, so a large undo that ran out of
 * time — or is still running in another tab — has removed people with no `undoneAt` yet. The
 * row went on showing its chips ("19 added") for people who were already gone.
 */
console.log("An undo still under way says so");
const partlyStats = { undoneRemoved: 12 };
const partly = render([
  item({ contactsCreated: 19, contactsUpdated: 6, duplicatesFound: 6, stats: partlyStats }),
]);
check("the row says it is partly undone", partly.includes("Partly undone"));
check("…and how many have gone so far", partly.includes("12 people removed so far"));
check("…and stops claiming the people it brought in", !partly.includes("19 added"));
check("…and never says it is undone outright", !partly.includes("Undone ·"));

// The sheet has to keep offering the undo while it is partway: it is resumable, and the way
// to finish it is to run it again. Rendered inside the Sheet root (its title reads that
// context) but without the portal, which renders nothing on the server.
const detailFor = (stats: ImportHistoryItem["stats"]): ImportDetail => ({
  item: item({
    contactsCreated: 19,
    contactsUpdated: 6,
    duplicatesFound: 6,
    // Inside the undo window, whenever this runs.
    createdAt: new Date(),
    stats,
  }),
  counts: { done: 25, skipped: 0, failed: 0, pending: 0 },
  problems: [],
  moreProblems: 0,
  people: { added: 19, existing: 6 },
});
const sheet = (detail: ImportDetail) =>
  renderToStaticMarkup(
    React.createElement(
      Sheet,
      { open: true },
      React.createElement(ImportDetailBody, { detail, loading: false }),
    ),
  );
const partlySheet = sheet(detailFor(partlyStats));
check("the sheet says it is partly undone", partlySheet.includes("12 people removed so far"));
check("…and still offers the undo, to finish it", partlySheet.includes("Undo this import"));
const doneSheet = sheet(
  detailFor({ undoneAt: "2026-09-22T12:00:00Z", undoneRemoved: 17, undoneKept: 2 }),
);
check("a finished undo is not offered again", !doneSheet.includes("Undo this import"));
check("…and says it is done", doneSheet.includes("Undone · 17 people removed"));

console.log("Every import type still renders");
const TYPES = [
  "linkedin_connections",
  "linkedin_messages",
  "contacts_file",
  "google_contacts",
  "outlook_contacts",
  "gmail_recruiter_scan",
  "outlook_recruiter_scan",
  "calendar_ics",
  "calendar_csv",
  "drive_docs",
];
for (const t of TYPES) {
  const html = render([item({ importType: t, fileName: null })]);
  // With no filename the row falls back to the source label, so the raw type appearing
  // anywhere means the label table does not know this type.
  check(`${t} has a name, not its raw type`, !html.includes(t), t);
}

console.log("A Drive import");
const drive = render([
  item({
    id: "d1",
    importType: "drive_docs",
    fileName: "3 Google Drive files",
    contactsCreated: 2,
    contactsUpdated: 1,
    duplicatesFound: 0,
    stats: {
      docsRead: 3,
      remindersCreated: 1,
      flaggedCommitments: [
        {
          id: "f1:commit",
          key: "commit",
          title: "Send the follow-up doc",
          personName: "Jamie Rivera",
          contactId: null,
          dueDateIso: "2026-09-10",
          sourceExcerpt: "I'll send the doc by Friday",
          actionKind: "follow_up",
          docName: "1:1 with Jamie.gdoc",
        },
      ],
    },
  }),
]);
check("names docs read", drive.includes("3 docs read"));
check("counts people added", drive.includes("2 added"));
check("counts people updated", drive.includes("1 updated"));
check(
  "counts the reminder, singular",
  drive.includes("1 reminder") && !drive.includes("1 reminders"),
);
check("flags what's worth a look", drive.includes("1 to look at"));
check("...and never with the word “failed”", !/\bfailed\b/i.test(drive), "");

console.log("Worth a look dates");
const SEP_21 = new Date("2026-09-21T12:00:00Z");
check("a due date reads as a day, not an ISO string", formatFlagDue("2026-09-01", SEP_21) === "Sep 1", formatFlagDue("2026-09-01", SEP_21));
check("…read as a calendar day in any timezone", formatFlagDue("2026-09-30", SEP_21) === "Sep 30", formatFlagDue("2026-09-30", SEP_21));
check("…with the year only when it isn't this one", formatFlagDue("2025-12-28", SEP_21) === "Dec 28, 2025", formatFlagDue("2025-12-28", SEP_21));

console.log("Empty state");
const empty = render([]);
check("says what to do", empty.includes("No imports yet"));

if (failures) {
  console.error(
    `\n${failures} history render check${failures === 1 ? "" : "s"} failed`,
  );
  process.exit(1);
}
console.log("\nimport history render smoke tests passed");
process.exit(0);
