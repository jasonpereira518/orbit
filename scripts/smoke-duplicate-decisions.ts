/**
 * The duplicates page's learning loop.
 *
 * Every merge and every "different people" call is kept as a labelled example of NUMBERS, and
 * a pooled model is fitted to them. What this guards:
 *
 *   - the page loads the extra evidence (all emails, interaction kinds, tags) and a plain
 *     "what matches / what differs" comparison for each pair
 *   - an example stores only numbers: no name, email or company can leak into the pooled table
 *   - an undone merge FLIPS its example (it was wrong); a taken-back dismissal WITHDRAWS it
 *   - taking a dismissal back puts the pair in the queue again
 *   - the model stays off with too few examples, comes on when it beats the baseline, and
 *     orders a separable pair above an unlike one
 *   - deleting an account's data removes its examples
 *
 * Writes to a throwaway PGlite directory (see ./smoke/_env). The server actions need a Clerk
 * session, so this drives the library layer they call.
 * Run: npx tsx scripts/smoke-duplicate-decisions.ts
 */
import "./smoke/_env";
import { run } from "./smoke/_env";
import { sql } from "drizzle-orm";
import { checker } from "./smoke/check";
import { closeDb, getDb, rowsOf } from "../src/db";
import { backfillContactIdentities } from "../src/lib/contact-identity";
import { dismissDuplicatePair, undismissDuplicatePair } from "../src/lib/contact-merge";
import { getDuplicateReview, signalsForPair } from "../src/lib/duplicate-review";
import {
  SIGNAL_KEYS,
  MIN_EXAMPLES,
  activeDuplicateModel,
  compareSignals,
  flipDecisionToDifferent,
  forgetDuplicateModel,
  recordDuplicateDecision,
  retractDecision,
  scoreWithModel,
  trainFromExamples,
  type SignalSide,
} from "../src/lib/duplicate-model";

const USER = "duplicate-decisions-smoke-user";
const t = checker();

async function reset() {
  const db = await getDb();
  await db.execute(sql`DELETE FROM duplicate_decisions`);
  await db.execute(sql`DELETE FROM duplicate_model`);
  await db.execute(sql`DELETE FROM duplicate_suggestions WHERE user_id = ${USER}`);
  await db.execute(sql`DELETE FROM contact_tags WHERE contact_id IN (SELECT id FROM contacts WHERE user_id = ${USER})`);
  await db.execute(sql`DELETE FROM tags WHERE user_id = ${USER}`);
  await db.execute(sql`DELETE FROM interactions WHERE user_id = ${USER}`);
  await db.execute(sql`DELETE FROM contacts WHERE user_id = ${USER}`);
  forgetDuplicateModel();
}

async function seed(fullName: string, company: string | null, email: string | null, school: string | null) {
  const db = await getDb();
  return rowsOf<{ id: string }>(
    await db.execute(sql`
      INSERT INTO contacts (user_id, full_name, company, email, school)
      VALUES (${USER}, ${fullName}, ${company}, ${email}, ${school})
      RETURNING id
    `)
  )[0]!.id;
}

const side = (over: Partial<SignalSide> = {}): SignalSide => ({
  fullName: "Grace Hopper",
  email: null,
  company: null,
  title: null,
  school: null,
  location: null,
  source: null,
  linkedinUrl: null,
  interactionCount: 0,
  createdAt: null,
  tags: [],
  eventIds: [],
  ...over,
});

async function main() {
  await reset();
  const db = await getDb();

  // --- the comparison itself (pure) -------------------------------------------------------
  const same = compareSignals(
    side({ company: "Acme", school: "MIT", tags: ["a", "b"], eventIds: ["e1"] }),
    side({ company: "ACME ", school: "mit", tags: ["b"], eventIds: ["e1"] }),
    0.6
  );
  t.check("same company / school are read case-insensitively", same.sameCompany === 1 && same.sameSchool === 1);
  t.check("shared tags and events are counted", same.sharedTags === 1 && same.sharedEvents === 1);
  const diff = compareSignals(side({ company: "Acme" }), side({ company: "Globex" }), 0.6);
  t.check("different companies read -1; unknown reads 0", diff.sameCompany === -1 && diff.sameTitle === 0);
  const freeMail = compareSignals(side({ email: "a@gmail.com" }), side({ email: "b@gmail.com" }), 0.6);
  t.check("a shared gmail.com is not evidence", freeMail.emailDomain === 0);
  const work = compareSignals(side({ email: "a@acme.com" }), side({ email: "b@acme.com" }), 0.6);
  t.check("a shared work domain is evidence", work.emailDomain === 1);

  // --- what the page loads -----------------------------------------------------------------
  const a = await seed("Grace Hopper", "Navy", "grace@navy.mil", "Vassar");
  const b = await seed("Grace Hopper", "Eckert-Mauchly", "ghopper@univac.com", "Yale");
  await backfillContactIdentities({ userId: USER });
  for (const [id, type] of [[a, "meeting"], [a, "email"], [b, "note"]] as const) {
    await db.execute(sql`
      INSERT INTO interactions (user_id, contact_id, interaction_type, raw_notes, ai_summary)
      VALUES (${USER}, ${id}::uuid, ${type}, 'x', ${`summary for ${type}`})
    `);
  }
  const tagId = rowsOf<{ id: string }>(
    await db.execute(sql`INSERT INTO tags (user_id, name) VALUES (${USER}, 'Navy friends') RETURNING id`)
  )[0]!.id;
  await db.execute(sql`INSERT INTO contact_tags (contact_id, tag_id) VALUES (${a}::uuid, ${tagId}::uuid)`);

  const review = await getDuplicateReview(USER);
  const pair = review.proposed.find((p) => [p.keep.id, p.merge.id].sort().join() === [a, b].sort().join());
  t.check("the same-name pair is on the page", !!pair);
  if (!pair) return finish();
  const rich = pair.keep.id === a ? pair.keep : pair.merge;
  t.check("interaction kinds are loaded", rich.interactionsByType.meeting === 1 && rich.interactionsByType.email === 1);
  t.check("interaction count still right (not the unqualified-column bug)", rich.interactionCount === 2);
  t.check("latest interactions carry their summary", rich.recent.some((r) => r.summary === "summary for meeting"));
  t.check("every email the contact carries is listed", rich.emails.includes("grace@navy.mil"));
  t.check("tags are loaded", rich.tags.includes("Navy friends"));
  t.check("the pair carries signals and plain-language notes", !!pair.signals && (pair.notes?.length ?? 0) > 0);
  t.check(
    "notes say the companies and schools differ",
    !!pair.notes?.some((n) => n.kind === "differ" && n.text === "Different companies") &&
      !!pair.notes?.some((n) => n.kind === "differ" && n.text === "Different schools")
  );

  // --- an example is numbers only ----------------------------------------------------------
  const signals = await signalsForPair(USER, a, b, 0.6);
  t.check("signals computed on the server for the pair", !!signals);
  const keys = Object.keys(signals ?? {}).sort().join();
  t.check("signals have exactly the declared keys", keys === [...SIGNAL_KEYS].sort().join());
  t.check("every signal is a finite number", Object.values(signals ?? {}).every((v) => typeof v === "number" && Number.isFinite(v)));
  const text = JSON.stringify(signals);
  t.check(
    "no name, email, company or school appears in an example",
    !/grace|hopper|navy|vassar|yale|univac|eckert/i.test(text)
  );

  // --- recording, flipping, retracting -----------------------------------------------------
  await recordDuplicateDecision(USER, { label: "same", source: "review_merge", signals: signals!, refId: "merge-1" });
  const label = async (ref: string) =>
    rowsOf<{ label: string; source: string }>(
      await db.execute(sql`SELECT label, source FROM duplicate_decisions WHERE user_id = ${USER} AND ref_id = ${ref}`)
    );
  t.check("a merge is stored as 'same'", (await label("merge-1"))[0]?.label === "same");
  await flipDecisionToDifferent(USER, "merge-1");
  const flipped = (await label("merge-1"))[0];
  t.check("an undone merge flips its example", flipped?.label === "different" && flipped.source === "undo_merge");
  await retractDecision(USER, "merge-1");
  t.check("a withdrawn example is gone", (await label("merge-1")).length === 0);

  // --- dismiss, then take it back -----------------------------------------------------------
  await dismissDuplicatePair(USER, a, b);
  const after = await getDuplicateReview(USER);
  t.check("a dismissed pair leaves the queue", !after.proposed.some((p) => p.keep.id === a || p.merge.id === a));
  await undismissDuplicatePair(USER, a, b);
  const back = await getDuplicateReview(USER);
  t.check("taking the dismissal back returns the pair", back.proposed.some((p) => p.keep.id === a || p.merge.id === a));

  // --- the model ---------------------------------------------------------------------------
  const make = (company: number, y: 0 | 1) => ({
    f: { ...Object.fromEntries(SIGNAL_KEYS.map((k) => [k, 0])), sameCompany: company, engineScore: 0.6 } as Record<string, number>,
    y,
  });
  t.check("too few examples: no model", trainFromExamples([make(1, 1), make(-1, 0)]) === null);
  const lots = Array.from({ length: 100 }, (_, i) => (i % 2 ? make(1, 1) : make(-1, 0)));
  const model = trainFromExamples(lots);
  t.check("a separable history trains an active model", !!model?.active, `acc ${model?.accuracy}`);
  if (model) {
    const yes = scoreWithModel(model, make(1, 1).f);
    const no = scoreWithModel(model, make(-1, 0).f);
    t.check("it ranks a same-company pair above a different-company one", yes > 0.7 && no < 0.3, `${yes.toFixed(2)} vs ${no.toFixed(2)}`);
  }
  const noise = Array.from({ length: 100 }, (_, i) => make(i % 3 === 0 ? 1 : -1, i % 7 === 0 ? 1 : 0));
  const weak = trainFromExamples(noise);
  t.check("a model that cannot beat the baseline stays off", !weak?.active || weak.accuracy! >= weak.baselineAccuracy! + 0.02);

  // The stored path: rows in, model row out, loaded back.
  for (let i = 0; i < MIN_EXAMPLES + 10; i++) {
    const e = lots[i % lots.length]!;
    await recordDuplicateDecision(USER, {
      label: e.y ? "same" : "different",
      source: "review_merge",
      signals: e.f as never,
    });
  }
  forgetDuplicateModel();
  const stored = await activeDuplicateModel();
  t.check("a model fitted to stored decisions is loaded", !!stored?.active);
  const row = rowsOf<{ n: number }>(await db.execute(sql`SELECT count(*)::int AS n FROM duplicate_model`))[0]!.n;
  t.check("the weights are saved once", row === 1);

  // --- account deletion ---------------------------------------------------------------------
  const { purgeUserData } = await import("../src/lib/user-data");
  await purgeUserData(USER, { only: ["contacts"] }).catch(() => undefined);
  const left = rowsOf<{ n: number }>(
    await db.execute(sql`SELECT count(*)::int AS n FROM duplicate_decisions WHERE user_id = ${USER}`)
  )[0]!.n;
  t.check("purging contacts removes the account's examples", left === 0, `${left} left`);

  await finish();
}

async function finish() {
  await reset();
  await closeDb();
  t.done("duplicate decisions");
}

run(main);
