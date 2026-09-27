/**
 * Phase D of the decisions plan: which calendar events become contacts, and the capture
 * checks (referral overrides, tags, invented people) — plus the two rule fixes that came with
 * them: a capture saved onto an existing contact ADDS its tags (it used to wipe the rest), and
 * tags match case-insensitively (it used to make "Fintech", "fintech" and "FinTech").
 *
 * Local PGlite, scripted deciders. Run: npx tsx scripts/smoke-decisions-capture.ts
 */
import "./smoke/_env";
import { eq } from "drizzle-orm";
import { getDb } from "../src/db";
import { contactTags, contacts, tags, userSettings } from "../src/db/schema";
import { classifyCalendarEvent } from "../src/lib/calendar-classify";
import type { ParsedCalendarEvent } from "../src/lib/calendar-import";
import { decideCalendarEvents } from "../src/lib/decisions/calendar";
import { decideCaptureChecks } from "../src/lib/decisions/capture";
import { CALENDAR_TUNING, CAPTURE_CHECK_TUNING } from "../src/lib/decisions/catalog";
import { NO_ENGINES, type Engines } from "../src/lib/decisions/engine";
import { parseAnswers, type Decider, type DecisionRequest, type QuestionMap } from "../src/lib/decisions/jev";
import { createContactForUser, updateContactForUser, withExistingTagNames } from "../src/lib/contact-writes";
import type { BulkNotePersonPreview } from "../src/lib/capture/types";
import { run } from "./smoke/_env";

const USER = "smoke-decisions-capture";
let failures = 0;
function check(label: string, ok: boolean, detail?: unknown) {
  if (ok) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.error(`  FAIL ${label}${detail === undefined ? "" : `\n       ${JSON.stringify(detail)}`}`);
  }
}

/** Answers every question in a request from `answer(key, question)`; null plays a failure. */
function scripted(answer: (key: string, q: { type: string; instructions: string }, state: unknown) => unknown): Decider & { asked: number } {
  const d = {
    asked: 0,
    async ask(req: DecisionRequest<QuestionMap>) {
      d.asked += 1;
      const raw = Object.fromEntries(Object.entries(req.questions).map(([k, q]) => [k, answer(k, q, req.state)]));
      const answers = parseAnswers(req.questions, { answers: raw });
      return answers ? { answers, model: "scripted" } : null;
    },
  };
  return d as unknown as Decider & { asked: number };
}
const jev = (d: Decider): Engines => ({ jev: d, llm: null });

const start = new Date("2026-08-04T15:00:00Z");
const event = (uid: string, summary: string, over: Partial<ParsedCalendarEvent> = {}): ParsedCalendarEvent => ({
  uid,
  summary,
  description: "",
  location: "",
  start,
  end: new Date(start.getTime() + 45 * 60_000),
  attendees: [{ name: "Joe", email: "joe@plumbing.example" }],
  organizer: null,
  ...over,
});
const SELF = ["me@orbit.example"];

async function calendar() {
  console.log("Calendar: the rules' free fixes");
  check("an event you declined is not a meeting", !classifyCalendarEvent(event("d", "Coffee with Priya", { selfResponse: "declined" }), SELF).keep);
  check("…nor a cancelled one", !classifyCalendarEvent(event("c", "Coffee with Priya", { status: "CANCELLED" }), SELF).keep);
  check("…while an accepted one still is", classifyCalendarEvent(event("a", "Coffee with Priya", { selfResponse: "accepted" }), SELF).keep);

  console.log("\nCalendar: the decision model's veto");
  const personalBlock = scripted(() => ({ choice: "personal_block", probabilities: { one_on_one: 0.05, networking: 0.03, personal_block: 0.9, internal_team: 0.01, invite: 0.005, other: 0.005 }, confidence: 0.9 }));
  const plumber = event("p", "Plumber visit", { description: "Fix kitchen sink leak." });
  check("the rules keep a one-guest plumber visit as a 1:1", classifyCalendarEvent(plumber, SELF).keep);
  const r = await decideCalendarEvents(jev(personalBlock), [plumber], SELF);
  check("Jev confident it is a personal block → skipped: no contact, no meeting, no follow-up", !r.decided[0].classification.keep && r.decided[0].by === "decision" && r.skippedByDecision === 1, r.decided[0].classification);

  const titleOnly = event("k", "Kai Moreno", { attendees: [] });
  const asked = scripted(() => ({ choice: "personal_block", probabilities: { one_on_one: 0.01, personal_block: 0.99 }, confidence: 0.99 }));
  const t = await decideCalendarEvents(jev(asked), [titleOnly], SELF);
  check("an event kept on a person's name alone is not put to the model (nothing more to read)", t.decided[0].classification.keep && asked.asked === 0);

  const oneOnOne = scripted(() => ({ choice: "one_on_one", probabilities: { one_on_one: 0.99 }, confidence: 0.99 }));
  const skipped = event("s", "Sprint retro", { attendees: [{ name: "Olivia", email: "olivia@orbit.example" }] });
  const s2 = await decideCalendarEvents(jev(oneOnOne), [skipped], SELF);
  check(`a rule "skip" is not kept, or even asked, while act is off (${String(CALENDAR_TUNING.act)})`, !s2.decided[0].classification.keep && s2.keptByDecision === 0);
  const none = await decideCalendarEvents(NO_ENGINES, [plumber], SELF);
  check("without Jev the rules decide exactly as before", none.decided[0].classification.keep && none.decided[0].by === "rules");
}

const person = (tagsList: string[], opportunities: BulkNotePersonPreview["opportunities"] = []) =>
  ({ parsed: { name: "Priya", tags: tagsList }, opportunities }) as unknown as BulkNotePersonPreview;

async function captureChecks() {
  console.log("\nCapture checks");
  const refusal = person([], [
    { kind: "referral", overriddenKind: "other", label: "Referrals", direction: null, sourceExcerpt: "They don't do referrals there.", rawDatePhrase: null, confidenceScore: 50, dueDateIso: null },
  ]);
  const noRef = scripted((_k, q) => (q.type === "noul" ? { noul: 0.05 } : null));
  const out = await decideCaptureChecks(jev(noRef), { items: [refusal], corpus: "", existingTags: [] });
  check("a 'referral' the language test forced onto a refusal is reverted to the model's kind", refusal.opportunities[0].kind === "other" && out.referralsReverted === 1);
  check("…and the override marker never reaches the client", refusal.opportunities[0].overriddenKind === undefined);

  const offer = person([], [
    { kind: "referral", overriddenKind: "job", label: "Referral", direction: null, sourceExcerpt: "She'll put my name forward for the PM role.", rawDatePhrase: null, confidenceScore: 50, dueDateIso: null },
  ]);
  await decideCaptureChecks(jev(scripted(() => ({ noul: 0.95 }))), { items: [offer], corpus: "", existingTags: [] });
  check("…while a real offer stays a referral", offer.opportunities[0].kind === "referral");

  const tagged = person(["ML", "robotics", "fintech"]);
  const mapML = scripted((k, q, state) => {
    const proposed = (state as { proposed: Record<string, string> }).proposed[k];
    const existing = (state as { existing_tags: Record<string, string> }).existing_tags;
    const target = proposed === "ML" ? Object.entries(existing).find(([, v]) => v === "Machine learning")?.[0] : "keep_new";
    return q.type === "choice" ? { choice: target, probabilities: { [target!]: 0.9 }, confidence: 0.9 } : null;
  });
  await decideCaptureChecks(jev(mapML), { items: [tagged], corpus: "", existingTags: ["Machine learning", "Fintech"] });
  check("a proposed tag the model maps onto an existing one is written as that one", tagged.parsed.tags?.includes("Machine learning") && !tagged.parsed.tags.includes("ML"), tagged.parsed.tags);
  check("…a genuinely new one is kept", tagged.parsed.tags?.includes("robotics"));

  const invented = [person([]), person([])];
  const presence = scripted(() => ({ choice: "not_in_note", probabilities: { not_in_note: 0.99 }, confidence: 0.99 }));
  const p = await decideCaptureChecks(jev(presence), { items: invented, corpus: "Coffee with Priya.", existingTags: [] });
  check(`nobody is dropped as invented while presenceAct is off (${String(CAPTURE_CHECK_TUNING.presenceAct)})`, invented.length === 2 && p.peopleDropped === 0 && presence.asked === 0);

  const untouched = person(["ML"], [{ kind: "referral", overriddenKind: "other", label: "x", direction: null, sourceExcerpt: "y", rawDatePhrase: null, confidenceScore: 50, dueDateIso: null }]);
  await decideCaptureChecks(NO_ENGINES, { items: [untouched], corpus: "", existingTags: ["Machine learning"] });
  check("without Jev the parse result is untouched", untouched.parsed.tags?.[0] === "ML" && untouched.opportunities[0].kind === "referral");
}

async function tagFixes() {
  console.log("\nTags: case-insensitive, and added rather than replaced");
  const db = await getDb();
  await db.delete(contacts).where(eq(contacts.userId, USER));
  await db.delete(tags).where(eq(tags.userId, USER));
  await db.delete(userSettings).where(eq(userSettings.userId, USER));
  await db.insert(userSettings).values({ userId: USER });
  const W = { skipRevalidate: true, skipEmbedding: true, skipSummary: true, skipCloseness: true };
  const created = await createContactForUser(USER, { fullName: "Priya Natarajan", tagNames: ["Fintech", "Mentors"] }, W);
  const other = await createContactForUser(USER, { fullName: "Leo Chen", tagNames: ["fintech"] }, W);
  const all = await db.select().from(tags).where(eq(tags.userId, USER));
  check("'fintech' lands on the existing 'Fintech' instead of making a second tag", all.filter((t) => t.name.toLowerCase() === "fintech").length === 1, all.map((t) => t.name));

  const next = await withExistingTagNames(USER, created.id, ["climate", "FINTECH"]);
  check("a capture's tags are ADDED to the contact's own (case-insensitive, first spelling wins)",
    next.join() === "Fintech,Mentors,climate", next);
  await updateContactForUser(USER, created.id, { tagNames: await withExistingTagNames(USER, created.id, []) }, W);
  const kept = await db.select().from(contactTags).where(eq(contactTags.contactId, created.id));
  check("…and a note with no tags leaves the contact's tags alone (it used to wipe them)", kept.length === 2, kept.length);

  await db.delete(contacts).where(eq(contacts.userId, USER));
  await db.delete(tags).where(eq(tags.userId, USER));
  await db.delete(userSettings).where(eq(userSettings.userId, USER));
  void other;
}

run(async () => {
  await calendar();
  await captureChecks();
  await tagFixes();
  console.log(failures === 0 ? "\nAll capture-decision checks passed." : `\n${failures} check(s) FAILED.`);
  if (failures > 0) process.exit(1);
});
