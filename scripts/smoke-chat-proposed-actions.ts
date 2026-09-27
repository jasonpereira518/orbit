/**
 * Chat-proposed actions: what the model's raw JSON is and is not allowed to shape
 * (`src/lib/chat-proposed-actions.ts`). The write itself is `commitProposedAction`
 * (@/actions/chat-actions, covered by `smoke-chat-actions.ts`); this is the gate the model's
 * own output has to pass through before a proposal exists at all.
 *
 * Pure: no DB. Run: npx tsx scripts/smoke-chat-proposed-actions.ts
 */
import { validateProposedActions } from "../src/lib/chat-proposed-actions";

let failures = 0;
function check(label: string, ok: boolean, detail?: string) {
  if (ok) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.error(`  FAIL ${label}${detail ? `\n       ${detail}` : ""}`);
  }
}

const ALLOWED = new Set(["c1", "c2"]);
const NAMES = new Map([["c1", "Ada Lovelace"], ["c2", "Marcus Osei"]]);

console.log("the three real shapes");
{
  const out = validateProposedActions(
    [
      { kind: "log_interaction", contact_id: "c1", text: "Talked about the Series A." },
      { kind: "create_reminder", contact_id: "c1", title: "Send the deck", description: "Promised on the call", due_date: null },
      { kind: "schedule_follow_up", contact_id: "c2", days: 14 },
    ],
    ALLOWED,
    NAMES
  );
  check("all three survive", out.length === 3, JSON.stringify(out));
  check("every one gets a minted id, not one from the input", out.every((a) => typeof a.id === "string" && a.id.length > 10));
  check("every one starts proposed", out.every((a) => a.status === "proposed"));
  check("log_interaction keeps its text", out[0]!.args.kind === "log_interaction" && (out[0]!.args as { text: string }).text === "Talked about the Series A.");
  check("the preview names the contact", out.every((a) => a.preview.includes(NAMES.get((a.args as { contactId?: string }).contactId ?? "") ?? "")));
}

console.log("what is dropped");
{
  check("an unknown kind is dropped", validateProposedActions([{ kind: "send_email", contact_id: "c1", text: "x" }], ALLOWED).length === 0);
  check("a forged contact id is dropped", validateProposedActions([{ kind: "log_interaction", contact_id: "not-allowed", text: "x" }], ALLOWED).length === 0);
  check("a malformed shape (missing text) is dropped", validateProposedActions([{ kind: "log_interaction", contact_id: "c1" }], ALLOWED).length === 0);
  check("an empty text after sanitizing is dropped", validateProposedActions([{ kind: "log_interaction", contact_id: "c1", text: "   " }], ALLOWED).length === 0);
  check("not an array at all is dropped, not thrown", validateProposedActions("not an array" as never, ALLOWED).length === 0);
  check("null is dropped, not thrown", validateProposedActions(null, ALLOWED).length === 0);
  check("a reminder with no contact is still allowed — contact_id is optional", validateProposedActions([{ kind: "create_reminder", contact_id: null, title: "Renew the domain" }], ALLOWED).length === 1);
}

console.log("dates");
{
  const farFuture = new Date(Date.now() + 400 * 24 * 60 * 60 * 1000).toISOString();
  const past = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();
  const near = new Date(Date.now() + 5 * 24 * 60 * 60 * 1000).toISOString();
  const outFuture = validateProposedActions([{ kind: "create_reminder", contact_id: "c1", title: "x", due_date: farFuture }], ALLOWED);
  check("a due date more than a year out is dropped, not the whole proposal", outFuture.length === 1 && (outFuture[0]!.args as { dueDate: string | null }).dueDate === null);
  const outPast = validateProposedActions([{ kind: "create_reminder", contact_id: "c1", title: "x", due_date: past }], ALLOWED);
  check("a date well in the past is dropped the same way", (outPast[0]!.args as { dueDate: string | null }).dueDate === null);
  const outNear = validateProposedActions([{ kind: "create_reminder", contact_id: "c1", title: "x", due_date: near }], ALLOWED);
  check("a reasonable near-future date survives", (outNear[0]!.args as { dueDate: string | null }).dueDate !== null);
  const outGarbage = validateProposedActions([{ kind: "create_reminder", contact_id: "c1", title: "x", due_date: "not a date" }], ALLOWED);
  check("garbage is null, not a throw", (outGarbage[0]!.args as { dueDate: string | null }).dueDate === null);
}

console.log("bounds and hygiene");
{
  const many = Array.from({ length: 10 }, (_, i) => ({ kind: "create_reminder" as const, contact_id: "c1", title: `Reminder ${i}` }));
  check("capped at 3, even given 10", validateProposedActions(many, ALLOWED).length === 3);
  const dup = [
    { kind: "log_interaction", contact_id: "c1", text: "Same note" },
    { kind: "log_interaction", contact_id: "c1", text: "Same note" },
  ];
  check("an identical proposal repeated in one answer is one card, not two", validateProposedActions(dup, ALLOWED).length === 1);
  const withMarkup = validateProposedActions([{ kind: "log_interaction", contact_id: "c1", text: "<script>alert(1)</script> real text" }], ALLOWED);
  check("agent-text sanitizing runs on free text (HTML stripped)", !withMarkup[0]!.preview.includes("<script>"), withMarkup[0]!.preview);
  const days = validateProposedActions([{ kind: "schedule_follow_up", contact_id: "c1", days: 9000 }], ALLOWED);
  check("an absurd day count is clamped, not passed through", (days[0]!.args as { days: number }).days <= 90);
  const zeroDays = validateProposedActions([{ kind: "schedule_follow_up", contact_id: "c1", days: 0 }], ALLOWED);
  check("zero or negative days clamps up to 1", (zeroDays[0]!.args as { days: number }).days >= 1);
}

console.log("never claims the write already happened");
{
  const out = validateProposedActions([{ kind: "create_reminder", contact_id: "c1", title: "Follow up" }], ALLOWED, NAMES);
  check("the preview reads as a proposal, not a past-tense record", /remind/i.test(out[0]!.preview) && !/^(added|done|reminded)/i.test(out[0]!.preview));
}

if (failures) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nAll proposed-action validation checks passed");
process.exit(0);
