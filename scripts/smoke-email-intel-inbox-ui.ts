/**
 * The "From your inbox" strip as drawn, and where mail-derived names are allowed to go.
 * Pure: no database.
 * Run: npx tsx scripts/smoke-email-intel-inbox-ui.ts
 */
import { readFileSync } from "node:fs";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { INBOX_KIND_LABELS, InboxPeople, type InboxPersonView } from "../src/components/radar/inbox-people";

function check(label: string, ok: boolean, detail?: string) {
  if (!ok) throw new Error(`${label} failed${detail ? `: ${detail}` : ""}`);
  console.log(`  ok  ${label}`);
}

const person = (over: Partial<InboxPersonView> = {}): InboxPersonView => ({
  key: "dana@northwind.example",
  name: "Dana Kim",
  title: "Technical Recruiter",
  kind: "process_update",
  summary: "Northwind wants to schedule a phone screen",
  at: "2026-09-29T12:00:00.000Z",
  ...over,
});

const noop = async () => ({ ok: true as const });
const render = (people: InboxPersonView[]) =>
  renderToStaticMarkup(React.createElement(InboxPeople, { people, onAdd: noop, onDismiss: noop }));

console.log("\nWhat is drawn");
const html = render([person(), person({ key: "lee@acme.example", name: "Lee Moss", title: null, kind: "job_posting", summary: "Acme is hiring" })]);
check("a heading a screen reader can find", html.includes('aria-labelledby="radar-inbox"') && html.includes("From your inbox"));
check("each name", html.includes("Dana Kim") && html.includes("Lee Moss"));
check("the title, when there is one", html.includes("Technical Recruiter"));
check("the sentence about the email", html.includes("Northwind wants to schedule a phone screen"));
check("the kind of email, in words", html.includes(INBOX_KIND_LABELS.process_update) && html.includes(INBOX_KIND_LABELS.job_posting));
check("an add button that says who", html.includes('aria-label="Add Dana Kim to Orbit"') && html.includes("Add to Orbit"));
check("a dismiss button that says who", html.includes('aria-label="Dismiss Lee Moss"'));
check("a person with no title has no stray separator", !html.includes("Lee Moss</span><span class=\"text-muted-foreground\"> · </span>"));

console.log("\nWhat is not");
check("no address, though the key is one", !html.includes("@") && !html.includes("northwind.example"));
check("nothing at all when there is nobody", render([]) === "");

console.log("\nThe words are all in one table");
check("every kind has a label", (["process_update", "job_posting", "event", "news"] as const).every((k) => INBOX_KIND_LABELS[k].length > 0));

console.log("\nWhere mail-derived names may not go");
// The strip's people come from other people's mail and are written by a model. They are shown to
// the user and added only when the user presses a button; none of this may ever be handed to a
// model or put in an email.
const FORBIDDEN_IMPORTERS = [
  "src/lib/radar/digest.ts",
  "src/lib/radar/digest-email.ts",
  "src/lib/radar/drafts.ts",
  "src/lib/radar/why-prompt.ts",
  "src/lib/radar/rerank-prompt.ts",
  "src/lib/radar/explain.ts",
  "src/lib/radar/rerank.ts",
  "src/lib/radar/autopilot.ts",
  "src/lib/radar/signals/email.ts",
];
for (const file of FORBIDDEN_IMPORTERS) {
  const source = readFileSync(file, "utf8");
  check(`${file} does not import the strip's loader`, !/inbox-people|inbox-pick|inbox-actions/.test(source));
}
const loader = readFileSync("src/lib/email-intel/inbox-people.ts", "utf8");
check("the loader never selects a quote", !/evidence_quote/.test(loader));
check("the loader never selects the thread's headers", !/email_threads|participants|subject/.test(loader.replace(/\/\*[\s\S]*?\*\//g, "")));

console.log("\nall inbox-ui checks passed");
