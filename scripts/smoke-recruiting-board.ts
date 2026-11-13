/**
 * The Recruiting board against PGlite: a view over email insights' events, plus the person's
 * corrections.
 *
 * Folding (pure): an application-system event and a model event about "Mastercard" and
 * "Mastercard, Inc." are one card; progress never goes backwards when old mail is re-read; a
 * rejection wins only from its own date on; a stage set by hand holds against older mail and
 * gives way to newer; a hidden company stays hidden whatever arrives; columns follow the stage
 * ranking so a card only moves right.
 *
 * Database: the loader reads only live process updates with a company and a stage; a
 * dismissed event drops out; corrections survive a new thread for the same company; and the
 * switch, the status line and the deletion all behave.
 *
 * Run: npx tsx scripts/smoke-recruiting-board.ts
 */
import "./smoke/_env";

import { eq } from "drizzle-orm";
import { getDb } from "../src/db";
import { emailEvents, emailThreads, recruitingOverrides, userSettings } from "../src/db/schema";
import { deleteEmailIntelData, enableEmailIntel } from "../src/lib/email-intel/store";
import { STAGE_LABELS, mergeStage, type RecruiterStage } from "../src/lib/recruiter-stages";
import {
  BOARD_COLUMNS,
  columnFor,
  companyKey,
  foldCompanies,
  gmailThreadUrl,
  type BoardEvent,
  type BoardOverride,
} from "../src/lib/recruiting-board";
import {
  getInsightsStatus,
  loadRecruitingBoard,
  setCompanyHiddenForUser,
  setCompanyStageForUser,
} from "../src/lib/recruiting-companies";
import { ensureUserSettings } from "../src/lib/user-settings";

let failures = 0;
function check(label: string, ok: boolean, detail?: string) {
  if (ok) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.error(`  FAIL ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

const USER = "user_recruiting_board_smoke";
const day = (n: number) => new Date(Date.UTC(2026, 9, n));

function ev(over: Partial<BoardEvent> & { company: string | null; stage: string | null; occurredAt: Date }): BoardEvent {
  return { role: null, source: "rule", summary: "", threadId: "t", ...over };
}
const none: BoardOverride[] = [];
const override = (over: Partial<BoardOverride> & { companyKey: string }): BoardOverride => ({
  hiddenAt: null,
  stage: null,
  stageAt: null,
  ...over,
});
const only = (events: BoardEvent[], overrides: BoardOverride[] = none) => foldCompanies(events, overrides);

async function main() {
  console.log("\nthe company key");
  check("legal suffixes fold", companyKey("Stripe, Inc.") === companyKey("stripe"));
  check("a Workday tenant meets the real name", companyKey("capitalone") === companyKey("Capital One"));
  check("aliases fold", companyKey("Meta Platforms, Inc.") === companyKey("Meta"));
  check("DeepMind is not Google", companyKey("Google DeepMind") !== companyKey("Google"));

  console.log("\none card per company");
  const merged = only([
    ev({ company: "Mastercard", stage: "applied", occurredAt: day(2), source: "rule", threadId: "t-wd" }),
    ev({
      company: "Mastercard, Inc.",
      role: "Analyst Intern",
      stage: "screening",
      occurredAt: day(5),
      source: "ai",
      summary: "They sent an assessment link.",
      threadId: "t-ai",
    }),
    ev({ company: "Datadog", stage: "applied", occurredAt: day(3), threadId: "t-dd" }),
  ]);
  check("a rule event and a model event about one company are one card", merged.companies.length === 2);
  const mc = merged.companies.find((c) => c.key === companyKey("Mastercard"))!;
  check("the stage is the furthest along", mc.stage === "screening");
  check("the model's spelling names the card", mc.name === "Mastercard, Inc.", mc.name);
  check("roles and the model's sentence ride along", mc.roles[0] === "Analyst Intern" && mc.summary === "They sent an assessment link.");
  check("the newest thread is the one to open", mc.threadId === "t-ai" && gmailThreadUrl("t-ai").endsWith("#all/t-ai"));
  check("newest activity sorts first", merged.companies[0].key === mc.key);
  check(
    "events with no company, no stage or a stage nobody knows are ignored",
    only([
      ev({ company: null, stage: "applied", occurredAt: day(1) }),
      ev({ company: "Acme", stage: null, occurredAt: day(1) }),
      ev({ company: "Acme", stage: "mystery", occurredAt: day(1) }),
    ]).companies.length === 0
  );

  console.log("\nstage over time");
  const stageOf = (events: BoardEvent[], overrides: BoardOverride[] = none) => only(events, overrides).companies[0]?.stage;
  check(
    "old mail re-read does not drag a live process back",
    stageOf([
      ev({ company: "A", stage: "interviewing", occurredAt: day(10) }),
      ev({ company: "A", stage: "applied", occurredAt: day(1) }),
    ]) === "interviewing"
  );
  check(
    "a later rejection ends it",
    stageOf([
      ev({ company: "A", stage: "interviewing", occurredAt: day(10) }),
      ev({ company: "A", stage: "rejected", occurredAt: day(12) }),
    ]) === "rejected"
  );
  check(
    "an older rejection does not outrank a newer screen",
    stageOf([
      ev({ company: "A", stage: "rejected", occurredAt: day(1) }),
      ev({ company: "A", stage: "screening", occurredAt: day(20) }),
    ]) === "screening"
  );

  console.log("\ncorrections");
  const key = companyKey("A");
  const set = [override({ companyKey: key, stage: "withdrawn", stageAt: day(15) })];
  check(
    "a stage set by hand holds against older mail",
    stageOf([ev({ company: "A", stage: "offer", occurredAt: day(10) })], set) === "withdrawn"
  );
  const heldCard = only([ev({ company: "A", stage: "offer", occurredAt: day(10) })], set).companies[0];
  check("and says it is yours", heldCard.stageSetByYou === true);
  const newer = only([ev({ company: "A", stage: "screening", occurredAt: day(20) })], set).companies[0];
  check("it gives way to newer mail", newer.stage === "screening" && newer.stageSetByYou === false);
  const hid = only(
    [
      ev({ company: "A", stage: "applied", occurredAt: day(1) }),
      ev({ company: "A", stage: "interviewing", occurredAt: day(30) }),
    ],
    [override({ companyKey: key, hiddenAt: day(5) })]
  );
  check("a hidden company stays hidden when new mail arrives", hid.companies.length === 0 && hid.hidden.length === 1);

  console.log("\ncolumns");
  const order: RecruiterStage[] = [
    "outreach_received",
    "outreach_sent",
    "applied",
    "in_conversation",
    "screening",
    "interviewing",
    "offer",
    "rejected",
    "withdrawn",
  ];
  check(
    "every stage has exactly one column",
    order.every((s) => BOARD_COLUMNS.filter((c) => (c.stages as readonly string[]).includes(s)).length === 1)
  );
  const index = (s: RecruiterStage) => BOARD_COLUMNS.findIndex((c) => c.id === columnFor(s));
  const progress = order.slice(0, 7);
  const rightOnly = progress.every((a, i) =>
    progress.slice(i + 1).every((b) => {
      // `a` before `b` in the pipeline, and `b` wins the merge: it must not sit to the left.
      const winner = mergeStage({ stage: a, at: day(1) }, { stage: b, at: day(2) }).stage;
      return winner !== b || index(b) >= index(a);
    })
  );
  check("a card only ever moves right", rightOnly);
  check("closed is last", BOARD_COLUMNS[BOARD_COLUMNS.length - 1].id === "closed");
  check("every stage reads as words", order.every((s) => Boolean(STAGE_LABELS[s])));

  console.log("\nthe loader");
  const db = await getDb();
  await ensureUserSettings(USER);
  const thread = async (threadId: string, decision: "ats_rule" | "classify" = "ats_rule") =>
    (
      await db
        .insert(emailThreads)
        .values({ userId: USER, threadId, lastMessageId: `${threadId}-m`, subject: "s", decision, status: "done" })
        .returning()
    )[0];
  const t1 = await thread("t-1");
  const t2 = await thread("t-2", "classify");
  const t3 = await thread("t-3");
  const event = (threadRowId: string, over: Partial<typeof emailEvents.$inferInsert>) =>
    db.insert(emailEvents).values({
      userId: USER,
      threadRowId,
      kind: "process_update",
      stage: "applied",
      company: "Stripe",
      occurredAt: day(3),
      summary: "Applied — Stripe",
      ...over,
    });
  await event(t1.id, { source: "rule", company: "Stripe", stage: "applied", occurredAt: day(3) });
  await event(t2.id, { source: "ai", company: "Stripe, Inc.", role: "SWE Intern", stage: "interviewing", occurredAt: day(9), summary: "Interview booked." });
  await event(t3.id, { company: "Ramp", stage: "applied", occurredAt: day(4), dismissedAt: day(6) });
  // Not process updates, or not about a company or stage: nothing for the board to show.
  const t4 = await thread("t-4");
  await event(t4.id, { kind: "job_posting", company: "Notion", stage: null });
  const t5 = await thread("t-5");
  await event(t5.id, { company: null, stage: "applied" });

  let board = await loadRecruitingBoard(USER);
  check("one company, folded from two threads", board.companies.length === 1 && board.companies[0].name === "Stripe, Inc.", JSON.stringify(board.companies.map((c) => c.name)));
  check("the furthest stage wins", board.companies[0].stage === "interviewing");
  check("a dismissed event, a job posting and a company-less event are not on the board", board.companies.every((c) => c.key === companyKey("Stripe")));

  await setCompanyStageForUser(USER, companyKey("Stripe"), "offer");
  board = await loadRecruitingBoard(USER);
  check("setting a stage moves the card and says so", board.companies[0].stage === "offer" && board.companies[0].stageSetByYou);

  await setCompanyHiddenForUser(USER, companyKey("Stripe"), true);
  const t6 = await thread("t-6");
  await event(t6.id, { source: "rule", company: "Stripe", stage: "rejected", occurredAt: new Date(Date.now() + 60_000) });
  board = await loadRecruitingBoard(USER);
  check("Not a job survives a new thread for the same company", board.companies.length === 0 && board.hidden.length === 1);

  await setCompanyHiddenForUser(USER, companyKey("Stripe"), false);
  board = await loadRecruitingBoard(USER);
  check("Put it back brings it home", board.companies.length === 1 && board.hidden.length === 0);
  check("with the newer mail on it", board.companies[0].stage === "rejected", board.companies[0].stage);

  console.log("\nthe switch");
  check("off to begin with", (await getInsightsStatus(USER)).enabled === false);
  await db.update(userSettings).set({ emailIntelCursorAt: day(2) }).where(eq(userSettings.userId, USER));
  await enableEmailIntel(USER);
  const on = await getInsightsStatus(USER);
  check("turning it on starts a fresh first look", on.enabled === true && on.lastSweepAt === null);

  console.log("\ndeleting what mail produced");
  check("overrides exist before", (await db.select().from(recruitingOverrides).where(eq(recruitingOverrides.userId, USER))).length === 1);
  await deleteEmailIntelData(USER);
  check("the corrections go with the events", (await db.select().from(recruitingOverrides).where(eq(recruitingOverrides.userId, USER))).length === 0);
  check("and the switch is off", (await getInsightsStatus(USER)).enabled === false);
}

main()
  .catch((err) => {
    failures++;
    console.error(err);
  })
  .finally(async () => {
    const db = await getDb();
    await db.delete(emailEvents).where(eq(emailEvents.userId, USER));
    await db.delete(emailThreads).where(eq(emailThreads.userId, USER));
    await db.delete(recruitingOverrides).where(eq(recruitingOverrides.userId, USER));
    await db.delete(userSettings).where(eq(userSettings.userId, USER));
    if (failures > 0) {
      console.error(`\n${failures} recruiting board check(s) failed`);
      process.exit(1);
    }
    console.log("\nall recruiting board checks passed");
    process.exit(0);
  });
