/**
 * Relationship UI rendered to static markup (pure): run summary, digest, open threads, badges, icons.
 * Run: npx tsx scripts/smoke-relationship-ui.ts
 */
import "./smoke/_env";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { RunSummaryView } from "../src/components/imports/relationship-run-summary";
import type { RunSummary } from "../src/lib/relationship-engine/summary-copy";
import { DigestSection } from "../src/components/contacts/contact-digest";
import { owedLabel } from "../src/components/contacts/contact-next-steps";
import { OpenThreadsList } from "../src/components/contacts/contact-open-threads";
import { chatSourceIcon, chatSourceLabel, IMessageIcon, WhatsAppIcon } from "../src/components/icons/chat-source-icons";
import { digestSourceLine, topicLine, type DigestView } from "../src/lib/relationship-engine/digest-copy";

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

const digest: DigestView = {
  whatTheyDo: "Runs growth at Ramp, hiring PMs", workingOn: "A self-serve onboarding revamp",
  summary: "You met at a fintech dinner and have traded hiring notes since.",
  topics: [{ label: "Hiring", lastDiscussedAt: "2026-09-30" }, { label: "Onboarding", lastDiscussedAt: "2026-08-12" }],
  openThreads: [], messageCount: 214, sources: ["whatsapp"], updatedAt: "2026-09-30T15:00:00.000Z", historyTruncatedBefore: null,
};
check("digest: source line, one source", digestSourceLine(digest) === "From 214 WhatsApp messages · updated Sep 30", String(digestSourceLine(digest)));
check("digest: source line, two sources", digestSourceLine({ ...digest, sources: ["linkedin", "imessage"] }) === "From 214 messages on LinkedIn and iMessage · updated Sep 30", String(digestSourceLine({ ...digest, sources: ["linkedin", "imessage"] })));
check("digest: source line, one message", digestSourceLine({ ...digest, messageCount: 1, sources: ["linkedin"] }) === "From 1 LinkedIn message · updated Sep 30");
check("digest: no source line without messages", digestSourceLine({ ...digest, messageCount: 0 }) === null);
check("digest: late-UTC timestamp keeps its UTC day", digestSourceLine({ ...digest, updatedAt: "2026-09-30T23:30:00.000Z" })?.endsWith("updated Sep 30") === true);
check("digest: early-UTC timestamp keeps its UTC day", digestSourceLine({ ...digest, updatedAt: "2026-10-01T00:30:00.000Z" })?.endsWith("updated Oct 1") === true);
check("digest: topic line", topicLine(digest.topics[0]) === "Hiring · last discussed Sep 30", topicLine(digest.topics[0]));
const dg = textOf(renderToStaticMarkup(React.createElement(DigestSection, { digest })));
check("digest: what they do", dg.includes("Runs growth at Ramp, hiring PMs"));
check("digest: working on", dg.includes("A self-serve onboarding revamp"));
check("digest: summary", dg.includes("You met at a fintech dinner"));
check("digest: topic chips", dg.includes("Hiring") && dg.includes("Onboarding"));
check("digest: source line rendered", dg.includes("From 214 WhatsApp messages"));

check("owed: me", owedLabel("me") === "You owe");
check("owed: them", owedLabel("them") === "They owe");
check("owed: none", owedLabel(null) === null);
const threads = [
  { key: "t1", text: "Intro to Priya", owedBy: "me" as const, sinceIso: "2026-05-01", interactionId: "x", excerpt: "can you intro me to Priya?", canRemind: true },
  { key: "t2", text: "Coffee in October", owedBy: null, sinceIso: "2026-04-01", interactionId: "y", excerpt: "coffee sometime?", canRemind: false },
];
const th = textOf(renderToStaticMarkup(React.createElement(OpenThreadsList, { threads, busyKey: null, onRemind: () => {}, onDismiss: () => {} })));
check("threads: count in the summary", th.includes("Open threads (2)"), th);
check("threads: quote and date", th.includes("can you intro me to Priya?") && th.includes("May 1"));
check("threads: owed badge", th.includes("You owe"));
check("threads: remind only where possible", (th.match(/Remind me/g) ?? []).length === 1, th);
check("threads: dismiss on each", (th.match(/Dismiss/g) ?? []).length === 2);

check("icon: whatsapp", chatSourceIcon("whatsapp") === WhatsAppIcon && chatSourceLabel("whatsapp") === "WhatsApp");
check("icon: imessage", chatSourceIcon("imessage") === IMessageIcon && chatSourceLabel("imessage") === "iMessage");
check("icon: others fall back", chatSourceIcon("linkedin") === null && chatSourceIcon(null) === null && chatSourceLabel(undefined) === null);
const svg = renderToStaticMarkup(React.createElement(WhatsAppIcon, { className: "size-4" }));
check("icon: decorative svg in currentColor", svg.startsWith("<svg") && svg.includes('aria-hidden="true"') && svg.includes("currentColor"), svg.slice(0, 120));

console.log("\nsmoke-relationship-ui: all checks passed");
process.exit(0);
