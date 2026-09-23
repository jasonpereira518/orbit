/**
 * The decision model on contacts (decisions/duplicates.ts, decisions/capture.ts) and the
 * undo fix it depends on:
 *
 *  - an undone merge STAYS undone (it used to come back on the very next duplicates-page
 *    render, because the sweep skipped only dismissed pairs and undo recorded nothing);
 *  - a merge resting on a NAME is vetoed by a confident "different people" — kept apart and
 *    queued for review — while identifier merges are never asked about;
 *  - the decision model's own merges stay off until their threshold is set, and when set,
 *    each is archived with its reason and undoable;
 *  - mentions: a blind first-name guess the sentence contradicts is un-linked; an ambiguous
 *    name is not linked while `act` is off; a card's default target follows Jev's pick.
 *
 * Local PGlite, scripted deciders. Run: npx tsx scripts/smoke-decisions-contacts.ts
 */
import "./smoke/_env";
import { and, eq } from "drizzle-orm";
import { getDb } from "../src/db";
import { contactMerges, contacts, duplicateSuggestions, userSettings } from "../src/db/schema";
import { mergeConfidentDuplicates } from "../src/lib/duplicate-sweep";
import { unmergeContacts } from "../src/lib/contact-merge";
import { resolveOrCreateContact } from "../src/lib/contact-resolve";
import { getDuplicateReview } from "../src/lib/duplicate-review";
import { DUPLICATE_TUNING, MENTION_TUNING } from "../src/lib/decisions/catalog";
import { NO_ENGINES, type Engines } from "../src/lib/decisions/engine";
import { parseAnswers, type Decider, type DecisionRequest, type QuestionMap } from "../src/lib/decisions/jev";
import { decideMentions, decideMergeTargets } from "../src/lib/decisions/capture";
import { run } from "./smoke/_env";

const USER = "smoke-decisions-contacts";
let failures = 0;
function check(label: string, ok: boolean, detail?: unknown) {
  if (ok) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.error(`  FAIL ${label}${detail === undefined ? "" : `\n       ${JSON.stringify(detail)}`}`);
  }
}

type Card = { name: string; company?: string; title?: string };

/** A scripted Jev: P(same) by whether the two cards share a company. */
function sameByCompany(pSame = 0.95, pDifferent = 0.1): Decider & { asked: number } {
  const d = {
    asked: 0,
    async ask(req: DecisionRequest<QuestionMap>) {
      d.asked += 1;
      const pairs = (req.state as { pairs: Record<string, { a: Card; b: Card }> }).pairs;
      const answers = parseAnswers(req.questions, {
        answers: Object.fromEntries(
          Object.entries(pairs).map(([k, { a, b }]) => [k, { noul: a.company && a.company === b.company ? pSame : pDifferent }])
        ),
      });
      return answers ? { answers, model: "scripted" } : null;
    },
  };
  return d as unknown as Decider & { asked: number };
}

/** A scripted Jev for "which contact": the candidate whose description contains `pick`. */
function picks(pick: string | "none", p = 0.95): Decider {
  return {
    async ask(req: DecisionRequest<QuestionMap>) {
      const [key, q] = Object.entries(req.questions)[0];
      const criteria = (q as { criteria: Record<string, string> }).criteria;
      const chosen =
        pick === "none"
          ? Object.keys(criteria).find((k) => k === "none" || k === "new")!
          : Object.entries(criteria).find(([, text]) => text.includes(pick))?.[0] ?? "none";
      const probabilities = Object.fromEntries(Object.keys(criteria).map((k) => [k, k === chosen ? p : (1 - p) / (Object.keys(criteria).length - 1)]));
      const answers = parseAnswers(req.questions, { answers: { [key]: { choice: chosen, probabilities, confidence: p } } });
      return answers ? { answers, model: "scripted" } : null;
    },
  } as Decider;
}

const jev = (d: Decider): Engines => ({ jev: d, llm: null });

async function reset() {
  const db = await getDb();
  await db.delete(contactMerges).where(eq(contactMerges.userId, USER));
  await db.delete(duplicateSuggestions).where(eq(duplicateSuggestions.userId, USER));
  await db.delete(contacts).where(eq(contacts.userId, USER));
  await db.delete(userSettings).where(eq(userSettings.userId, USER));
  await db.insert(userSettings).values({ userId: USER });
}

async function add(fullName: string, company: string | null, title: string | null, createdAt = new Date()) {
  const db = await getDb();
  const [row] = await db.insert(contacts).values({ userId: USER, fullName, company, title, createdAt }).returning();
  return row.id;
}

async function alive(id: string) {
  const db = await getDb();
  return Boolean(await db.query.contacts.findFirst({ where: and(eq(contacts.userId, USER), eq(contacts.id, id)) }));
}

async function undoFix() {
  console.log("An undone merge stays undone");
  await reset();
  const a = await add("Ada Park", "Stripe", "Engineer", new Date(Date.now() - 60_000));
  const b = await add("Ada Park", "Stripe", "Staff Engineer");
  const first = await mergeConfidentDuplicates(USER);
  check("the sweep merges a same-name + same-company pair (rules, no engines)", first.merged === 1 && !(await alive(b)));
  const db = await getDb();
  const [merge] = await db.select().from(contactMerges).where(eq(contactMerges.userId, USER));
  await unmergeContacts(USER, merge.id);
  check("undo brings the contact back", await alive(b));
  const again = await mergeConfidentDuplicates(USER);
  check("…and the next sweep (every duplicates-page render) does NOT merge it again", again.merged === 0 && (await alive(b)));
  const dismissal = await db.query.duplicateSuggestions.findFirst({ where: eq(duplicateSuggestions.userId, USER) });
  check("because the undo was recorded as a dismissal", dismissal?.status === "dismissed" && dismissal.reason === "Merge undone", dismissal);
  void a;
}

async function sweepVeto() {
  console.log("\nThe sweep asks before merging on a name");
  await reset();
  const google = await add("Michael Chen", "Google", "Software Engineer", new Date(Date.now() - 60_000));
  const meta = await add("Michael Chen", "Meta", "Software Engineer");
  const decider = sameByCompany();
  const r = await mergeConfidentDuplicates(USER, { engines: jev(decider) });
  check("same name + title at different employers: the decision model keeps them apart", r.merged === 0 && (await alive(google)) && (await alive(meta)));
  check("…reported as a veto", r.vetoed === 1, r);
  const review = await getDuplicateReview(USER, { engines: jev(sameByCompany()) });
  const pair = review.proposed.find((p) => [p.keep.id, p.merge.id].sort().join() === [google, meta].sort().join());
  check("…and queued for review, below the confidence line so the queue shows it", Boolean(pair) && (pair?.confidence ?? 1) < 0.85, review.proposed.map((p) => [p.reason, p.confidence]));
  check("…carrying the model's read", pair?.decision?.engine === "jev" && (pair?.decision?.sameProbability ?? 1) <= 0.2, pair?.decision);

  await reset();
  await add("Priya Natarajan", "Stripe", "Product Manager", new Date(Date.now() - 60_000));
  const b = await add("Priya Natarajan", "Stripe", "Senior Product Manager");
  const same = await mergeConfidentDuplicates(USER, { engines: jev(sameByCompany()) });
  check("the same person (same company) still merges with the model watching", same.merged === 1 && !(await alive(b)));

  await reset();
  const db = await getDb();
  const x = await add("Sam Lee", "Acme", null, new Date(Date.now() - 60_000));
  const y = await add("Sam Lee", "Other Co", null);
  await db.update(contacts).set({ email: "sam@lee.example" }).where(eq(contacts.id, x));
  await db.update(contacts).set({ email: "sam@lee.example" }).where(eq(contacts.id, y));
  // Identity rows are claimed on write paths; seed one so the sweep's identifier arm sees it.
  await db.execute(
    (await import("drizzle-orm")).sql`INSERT INTO contact_identities (user_id, contact_id, kind, value) VALUES (${USER}, ${x}::uuid, 'email', 'sam@lee.example') ON CONFLICT DO NOTHING`
  );
  const idDecider = sameByCompany(0.95, 0.01);
  const byId = await mergeConfidentDuplicates(USER, { engines: jev(idDecider) });
  check("an identifier merge (same email) is never put to the model", byId.merged === 1 && idDecider.asked === 0, { byId, asked: idDecider.asked });
}

async function autonomy() {
  console.log("\nThe model's own merges");
  // A pair the rules leave for review: the same bare name, different employers.
  await reset();
  const older = await add("Nora Lindqvist", "Spotify", "Product Manager", new Date(Date.now() - 60_000));
  const newer = await add("Nora Lindqvist", "Klarna", "Director of Product");
  const confident: Decider = {
    async ask(req) {
      const keys = Object.keys(req.questions);
      const answers = parseAnswers(req.questions, { answers: Object.fromEntries(keys.map((k) => [k, { noul: 0.99 }])) });
      return answers ? { answers, model: "scripted" } : null;
    },
  };
  const off = await mergeConfidentDuplicates(USER, { engines: jev(confident) });
  check(`with act off (${String(DUPLICATE_TUNING.jev.act)}, as it ships) a bare-name pair is never merged by the model`, off.merged === 0 && (await alive(newer)));

  const tuning = DUPLICATE_TUNING.jev as { act: number | null };
  tuning.act = 0.97;
  try {
    const on = await mergeConfidentDuplicates(USER, { engines: jev(confident) });
    check("with act set, a confident bare-name pair is merged", on.merged === 1 && !(await alive(newer)));
    const db = await getDb();
    const [merge] = await db.select().from(contactMerges).where(eq(contactMerges.userId, USER));
    check("…archived with the model's reason and probability, for the undo list",
      merge?.reason === "Decision model: same person (0.99)" && merge.confidence === 0.99, merge && { reason: merge.reason, confidence: merge.confidence });
    await unmergeContacts(USER, merge.id);
    const after = await mergeConfidentDuplicates(USER, { engines: jev(confident) });
    check("…undoable, and an undo is final: the model does not merge them again", after.merged === 0 && (await alive(newer)));
  } finally {
    tuning.act = null;
  }
  void older;
}

async function resolveVeto() {
  console.log("\nA single write asks before folding on a name");
  await reset();
  const existing = await add("Michael Chen", "Google", "Software Engineer");
  const input = { fullName: "Michael Chen", company: "Meta", title: "Software Engineer" };
  const WRITE = { skipRevalidate: true, skipEmbedding: true, skipSummary: true, skipCloseness: true };
  const kept = await resolveOrCreateContact(USER, input, { ...WRITE, engines: jev(sameByCompany()) });
  check("a confident 'different people' creates a new contact instead of folding", kept.outcome === "created" && kept.contactId !== existing);
  const db = await getDb();
  const queued = await db.query.duplicateSuggestions.findFirst({ where: eq(duplicateSuggestions.userId, USER) });
  check("…and queues the pair for review, below the line", queued?.status === "pending" && queued.confidence < 0.85 && /held for review/.test(queued.reason), queued);

  await reset();
  const e2 = await add("Michael Chen", "Google", "Software Engineer");
  const folded = await resolveOrCreateContact(USER, input, { ...WRITE, engines: NO_ENGINES });
  check("without a decision model the write folds exactly as before", folded.outcome === "matched" && folded.contactId === e2);
}

async function mentionsAndTargets() {
  console.log("\nMentions and a card's default target");
  const subjects = [{ id: "s1", fullName: "Sam Altman", email: null, linkedinUrl: null, xHandle: null, company: "OpenAI", title: "CEO" }];
  const guess = {
    resolved: [{ text: "Sam", context: null, nearPerson: null, contactId: "s1", confidence: 0.7, matchedBy: "first_name_unique" as const }],
    unresolved: [],
  };
  const vetoed = await decideMentions(jev(picks("none")), { ...guess, subjects, corpus: "Ran into Sam at the gym, he's training for a marathon." });
  check("a blind first-name guess the sentence contradicts is un-linked", vetoed.resolved.length === 0 && vetoed.unresolved[0]?.text === "Sam");
  const kept = await decideMentions(jev(picks("Sam Altman")), { ...guess, subjects, corpus: "Sam said OpenAI is hiring." });
  check("…and one it supports stays linked", kept.resolved[0]?.contactId === "s1");
  const noEngines = await decideMentions(NO_ENGINES, { ...guess, subjects, corpus: "anything" });
  check("…and with no engines, today's result stands", noEngines.resolved[0]?.contactId === "s1");

  const two = [
    { id: "a1", fullName: "Alex Chen", email: null, linkedinUrl: null, xHandle: null, company: "Figma", title: "Designer" },
    { id: "a2", fullName: "Alex Rivera", email: null, linkedinUrl: null, xHandle: null, company: "Oracle", title: "Sales" },
  ];
  const ambiguous = await decideMentions(jev(picks("Alex Chen", 0.99)), {
    resolved: [],
    unresolved: [{ text: "Alex", context: null, nearPerson: null }],
    subjects: two,
    corpus: "Alex from Figma sent the docs.",
  });
  check(`an ambiguous name is not linked while act is off (${String(MENTION_TUNING.act)})`, ambiguous.resolved.length === 0);

  const targets = await decideMergeTargets(jev(picks("none")), [
    { person: { name: "Jo", company: null, role: null, excerpt: "Jo, a new friend from climbing." }, duplicates: [{ id: "d1", fullName: "Jo Park", company: "Stripe", title: "PM", confidence: 0.6 }] },
    { person: { name: "Leo Chen", company: "Notion", role: null, excerpt: "Leo from Notion." }, duplicates: [{ id: "d2", fullName: "Leo Chen", company: "Notion", title: "Eng", confidence: 0.9 }] },
  ]);
  check("a card whose only match is a bare name defaults to a new person when the model says so", targets[0] === "new");
  check("…and one the rules are already confident about is not asked", targets[1] === null);
  const picked = await decideMergeTargets(jev(picks("Jo Park")), [
    { person: { name: "Jo", company: "Stripe", role: null, excerpt: "Jo from Stripe." }, duplicates: [{ id: "d1", fullName: "Jo Park", company: "Stripe", title: "PM", confidence: 0.6 }] },
  ]);
  check("…or to the existing contact it picks", picked[0] === "d1");
  check("without Jev nothing changes", (await decideMergeTargets(NO_ENGINES, [{ person: { name: "x", company: null, role: null, excerpt: "" }, duplicates: [] }]))[0] === null);
}

run(async () => {
  await undoFix();
  await sweepVeto();
  await autonomy();
  await resolveVeto();
  await mentionsAndTargets();
  const db = await getDb();
  await db.delete(contactMerges).where(eq(contactMerges.userId, USER));
  await db.delete(duplicateSuggestions).where(eq(duplicateSuggestions.userId, USER));
  await db.delete(contacts).where(eq(contacts.userId, USER));
  await db.delete(userSettings).where(eq(userSettings.userId, USER));
  console.log(failures === 0 ? "\nAll contact-decision checks passed." : `\n${failures} check(s) FAILED.`);
  if (failures > 0) process.exit(1);
});
