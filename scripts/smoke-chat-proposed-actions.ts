/**
 * Chat-proposed actions from the one-pass answer: what its raw JSON tail is and is not allowed
 * to shape (`parseAnswerTail`, src/lib/chat-proposed-actions.ts), and the cards that come out
 * once each proposal is checked against its catalog entry (`proposalsFromAnswerTail`,
 * src/lib/tools/chat-proposals.ts). The write itself is `commitProposedAction`
 * (@/actions/chat-actions, covered by `smoke-chat-actions.ts`).
 *
 * Pure: no DB. Run: npx tsx scripts/smoke-chat-proposed-actions.ts
 */
import { randomUUID } from "node:crypto";
import { parseAnswerTail } from "../src/lib/chat-proposed-actions";
import { proposalsFromAnswerTail } from "../src/lib/tools/chat-proposals";

let failures = 0;
function check(label: string, ok: boolean, detail?: string) {
  if (ok) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.error(`  FAIL ${label}${detail ? `\n       ${detail}` : ""}`);
  }
}

const C1 = randomUUID();
const C2 = randomUUID();
const R1 = randomUUID();
const ALLOWED = new Set([C1, C2]);
const NAMES = new Map([[C1, "Ada Lovelace"], [C2, "Marcus Osei"]]);
const REMINDERS = new Map([[R1, "Send Ada the deck"]]);
const cards = (raw: unknown, reminders: Map<string, string> = new Map()) => proposalsFromAnswerTail(raw, ALLOWED, NAMES, reminders);
const parse = (raw: unknown, reminders: Map<string, string> = new Map()) => parseAnswerTail(raw, ALLOWED, new Set(reminders.keys()));

console.log("the three common shapes become catalog writes");
{
  const out = cards([
    { kind: "log_interaction", contact_id: C1, text: "Talked about the Series A." },
    { kind: "create_reminder", contact_id: C1, title: "Send the deck", description: "Promised on the call", due_date: null },
    { kind: "schedule_follow_up", contact_id: C2, days: 14 },
  ]);
  check("all three survive", out.length === 3, JSON.stringify(out));
  check("each names its catalog write", out.map((a) => a.args.tool).join(",") === "log_note,create_reminder,schedule_follow_up", out.map((a) => a.args.tool).join(","));
  check("every one gets a minted id, not one from the input", out.every((a) => typeof a.id === "string" && a.id.length > 10));
  check("every one starts proposed", out.every((a) => a.status === "proposed"));
  check("the note keeps its text", out[0]!.args.input.text === "Talked about the Series A.");
  check("the preview names the contact", out[0]!.preview.includes("Ada Lovelace") && out[2]!.preview.includes("Marcus Osei"), out.map((a) => a.preview).join(" | "));
  check("each card carries its tier and contact", out[0]!.tier === "auto" && out[2]!.tier === "confirm" && out[2]!.contactId === C2);
  check("a reminder about nobody has no contactId key at all", !("contactId" in parse([{ kind: "create_reminder", contact_id: null, title: "Renew the domain" }])[0]!.input));
}

console.log("what is dropped");
{
  check("an unknown kind is dropped", cards([{ kind: "send_email", contact_id: C1, text: "x" }]).length === 0);
  check("a forged contact id is dropped", cards([{ kind: "log_interaction", contact_id: randomUUID(), text: "x" }]).length === 0);
  check("a malformed shape (missing text) is dropped", cards([{ kind: "log_interaction", contact_id: C1 }]).length === 0);
  check("an empty text after sanitizing is dropped", cards([{ kind: "log_interaction", contact_id: C1, text: "   " }]).length === 0);
  check("not an array at all is dropped, not thrown", cards("not an array").length === 0);
  check("null is dropped, not thrown", cards(null).length === 0);
  check("a reminder with no contact is still allowed — contact_id is optional", cards([{ kind: "create_reminder", contact_id: null, title: "Renew the domain" }]).length === 1);
  // The catalog's own schema is the last word: an id that is allowed but not a uuid fails it.
  const loose = proposalsFromAnswerTail([{ kind: "log_interaction", contact_id: "c1", text: "x" }], new Set(["c1"]), new Map());
  check("an input the catalog's schema refuses makes no card", loose.length === 0, JSON.stringify(loose));
}

console.log("dates");
{
  const day = (offsetDays: number) => new Date(Date.now() + offsetDays * 86_400_000).toISOString();
  const due = (raw: string) => parse([{ kind: "create_reminder", contact_id: C1, title: "x", due_date: raw }])[0]!.input.due_date;
  check("a due date more than a year out is dropped, not the whole proposal", due(day(400)) === undefined);
  check("a date well in the past is dropped the same way", due(day(-10)) === undefined);
  check("a reasonable near-future date survives", typeof due(day(5)) === "string");
  check("garbage is dropped, not a throw", due("not a date") === undefined);
}

console.log("bounds and hygiene");
{
  const many = Array.from({ length: 10 }, (_, i) => ({ kind: "create_reminder" as const, contact_id: C1, title: `Reminder ${i}` }));
  check("capped at 3, even given 10", cards(many).length === 3);
  const dup = [
    { kind: "log_interaction", contact_id: C1, text: "Same note" },
    { kind: "log_interaction", contact_id: C1, text: "Same note" },
  ];
  check("an identical proposal repeated in one answer is one card, not two", cards(dup).length === 1);
  const withMarkup = cards([{ kind: "log_interaction", contact_id: C1, text: "<script>alert(1)</script> real text" }]);
  check("agent-text sanitizing runs on free text (HTML stripped)", !withMarkup[0]!.preview.includes("<script>"), withMarkup[0]!.preview);
  check("an absurd day count is clamped, not passed through", Number(cards([{ kind: "schedule_follow_up", contact_id: C1, days: 9000 }])[0]!.args.input.days) === 90);
  check("zero or negative days clamps up to 1", Number(cards([{ kind: "schedule_follow_up", contact_id: C1, days: 0 }])[0]!.args.input.days) === 1);
}

console.log("contact edits and new contacts");
{
  const out = cards([
    { kind: "update_contact", contact_id: C1, title: "VP Engineering", company: "Stripe", email: "not an email" },
    { kind: "create_contact", full_name: "Priya Shah", title: "Founder", company: "Ledgerly" },
  ]);
  const update = out[0]?.args;
  check("update_contact survives with the fields it named", update?.tool === "update_contact" && update.input.title === "VP Engineering" && update.input.company === "Stripe", JSON.stringify(out[0]));
  check("a malformed email is dropped from the patch, not stored", update?.input.email === undefined);
  check("the update preview names the person and every change", /Ada Lovelace/.test(out[0]!.preview) && /VP Engineering/.test(out[0]!.preview) && /Stripe/.test(out[0]!.preview), out[0]?.preview);
  check("create_contact survives", out[1]?.args.tool === "create_contact" && out[1]!.preview.includes("Priya Shah (Founder @ Ledgerly)"), out[1]?.preview);
  check("an update to someone the model was not shown is dropped", cards([{ kind: "update_contact", contact_id: randomUUID(), title: "x" }]).length === 0);
  check("an update with nothing to change is dropped", cards([{ kind: "update_contact", contact_id: C1 }]).length === 0);
  const notes = cards([{ kind: "update_contact", contact_id: C1, title: "x", notes: "wiped" }])[0]!.args.input;
  check("notes cannot ride along — neither notes nor notes_append is set", !("notes" in notes) && !("notes_append" in notes), JSON.stringify(notes));
}

console.log("reminders: only ones the model was shown");
{
  const out = cards(
    [
      { kind: "complete_reminder", reminder_id: R1 },
      { kind: "snooze_reminder", reminder_id: R1, days: 500 },
    ],
    REMINDERS
  );
  check("complete and snooze survive", out.length === 2, JSON.stringify(out));
  check("the preview quotes the reminder", out[0]!.preview.includes("Send Ada the deck"), out[0]?.preview);
  check("snooze days clamp to 90", Number(out[1]!.args.input.days) === 90);
  check("a reminder id outside the shown list is dropped", cards([{ kind: "complete_reminder", reminder_id: randomUUID() }], REMINDERS).length === 0);
  check("with no reminders shown, none can be proposed", cards([{ kind: "complete_reminder", reminder_id: R1 }]).length === 0);
}

console.log("never claims the write already happened");
{
  const out = cards([{ kind: "create_reminder", contact_id: C1, title: "Follow up" }]);
  check("the preview reads as a proposal, not a past-tense record", /remind/i.test(out[0]!.preview) && !/^(added|done|reminded)/i.test(out[0]!.preview), out[0]?.preview);
}

if (failures) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nAll proposed-action validation checks passed");
process.exit(0);
