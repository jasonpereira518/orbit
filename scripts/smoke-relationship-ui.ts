/**
 * Relationship UI rendered to static markup (pure): run summary, digest, open threads, badges, icons.
 * Run: npx tsx scripts/smoke-relationship-ui.ts
 */
import "./smoke/_env";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { RunSummaryView } from "../src/components/imports/relationship-run-summary";
import type { RunSummary } from "../src/lib/relationship-engine/summary-copy";

function check(label: string, condition: boolean, detail?: string) {
  if (!condition) throw new Error(`${label} failed${detail ? `: ${detail}` : ""}`);
  console.log(`  ok  ${label}`);
}
const textOf = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&#x27;|&#39;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();

const base: RunSummary = {
  id: "r1", importId: "i1", status: "done", processed: 184, skipped: 12, failed: 0,
  remindersCreated: 9, openThreadsAdded: 31, factsAdded: 40, remaining: 0,
  reminders: [{ id: "m1", title: "Send Maya the deck", dueIso: "2026-10-09", contactId: "c1", contactName: "Maya Chen", status: "pending" }],
  flags: [{ key: "k1", contactId: "c1", contactName: "Maya Chen", title: "Check Maya sent the deck", dueDateIso: "2026-09-26", sourceExcerpt: "I'll send the deck Friday", interactionId: "x1" }],
  truncatedPeople: 2, parkedPeople: [], createdAt: "2026-10-03T10:00:00.000Z", finishedAt: "2026-10-03T10:20:00.000Z", undoable: true,
};

const done = textOf(renderToStaticMarkup(React.createElement(RunSummaryView, { summary: base, busyKey: null, onUndo: () => {}, onRemind: () => {}, onDismiss: () => {} })));
check("run: headline", done.includes("Analyzed 184 people · 9 reminders · 31 open threads · 12 skipped (too short)"), done);
check("run: reminder listed with its person", done.includes("Send Maya the deck") && done.includes("Maya Chen"));
check("run: undo all offered", done.includes("Undo all"));
check("run: flag with its quote and a one-click remind", done.includes("Check Maya sent the deck") && done.includes("I'll send the deck Friday") && done.includes("Remind me"), done);
check("run: older history note", done.includes("Older history not read for 2 people"));

const running = textOf(renderToStaticMarkup(React.createElement(RunSummaryView, { summary: { ...base, status: "running", processed: 25, remaining: 159, undoable: false }, busyKey: null, onUndo: () => {} })));
check("run: progress while running", running.includes("Analyzing 25 of 184 — the rest within a few hours"));
check("run: no undo while running", !running.includes("Undo all"));

const shared = textOf(renderToStaticMarkup(React.createElement(RunSummaryView, { summary: base, busyKey: null, shared: true })));
check("run: shared run says so", shared.includes("Analyzed together with an earlier upload"));

console.log("\nsmoke-relationship-ui: all checks passed");
process.exit(0);
