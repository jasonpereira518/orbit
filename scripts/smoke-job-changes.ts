/**
 * Job moves: what counts as one, and what recording one does.
 *
 * The detection half is pure. The recording half runs against PGlite, and also through
 * `researchContactWorkHistory` with a fake researcher, so the whole "search → compare →
 * log → act" path is exercised with no AI key and no network.
 *
 * Run: npx tsx scripts/smoke-job-changes.ts
 */
import "./smoke/_env";

import { and, eq } from "drizzle-orm";
import { getDb } from "../src/db";
import { aiSuggestions, contactCareerMoves, contacts, interactions } from "../src/db/schema";
import type { IncomingExperience } from "../src/lib/contact-profile";
import { isLoggedTouch } from "../src/lib/interaction-provenance";
import {
  detectJobChanges,
  getRecentMoveLines,
  JOB_CHANGE_SUGGESTION_TYPE,
  recentMoveAsFieldChanges,
  type JobBaseline,
  type SnapshotRole,
} from "../src/lib/job-changes";
import type { WorkHistoryResearcher } from "../src/lib/work-history-research";
import { researchContactWorkHistory } from "../src/lib/work-history-research";

const USER = "smoke-job-changes-user";

function check(label: string, condition: boolean, detail?: string) {
  if (!condition) throw new Error(`${label} failed${detail ? `: ${detail}` : ""}`);
  console.log(`  ok  ${label}`);
}

function role(organization: string, extra: Partial<IncomingExperience> = {}): IncomingExperience {
  return {
    kind: "role",
    organization,
    title: "PM",
    fieldOfStudy: null,
    location: null,
    description: null,
    startYear: 2020,
    startMonth: 1,
    endYear: null,
    endMonth: null,
    isCurrent: true,
    ...extra,
  };
}

function snap(organization: string, extra: Partial<SnapshotRole> = {}): SnapshotRole {
  return { organization, title: "PM", startYear: 2020, startMonth: 1, isCurrent: true, ...extra };
}

function baseline(roles: SnapshotRole[], recentlyLeft: string[] = []): JobBaseline {
  return { hasBaseline: true, roles, recentlyLeft: new Set(recentlyLeft) };
}

async function reset() {
  const db = await getDb();
  await db.delete(aiSuggestions).where(eq(aiSuggestions.userId, USER));
  await db.delete(contacts).where(eq(contacts.userId, USER));
}

function detection() {
  console.log("\nDetection");
  const joined = detectJobChanges(baseline([snap("Stripe")]), [
    role("Ramp", { title: "Staff PM", startYear: 2026, startMonth: 8 }),
    role("Stripe", { isCurrent: false, endYear: 2026, endMonth: 7 }),
  ]);
  check("a new current employer is a join", joined.length === 1 && joined[0]?.kind === "joined", JSON.stringify(joined));
  check("…from the employer it replaced", joined[0]?.fromOrg === "Stripe" && joined[0]?.toOrg === "Ramp");
  check("…carrying the new title", joined[0]?.toTitle === "Staff PM");

  const family = detectJobChanges(baseline([snap("Google")]), [role("Google DeepMind")]);
  check("Google → Google DeepMind is not a move", family.length === 0, JSON.stringify(family));

  const banks = detectJobChanges(baseline([snap("Bank of America")]), [role("Bank of Montreal", { startYear: 2026 })]);
  check("Bank of America → Bank of Montreal IS a move", banks.length === 1 && banks[0]?.kind === "joined", JSON.stringify(banks));

  const promo = detectJobChanges(baseline([snap("Stripe", { title: "PM" })]), [role("Stripe, Inc.", { title: "Senior PM" })]);
  check("a new title at the same employer is a title change", promo.length === 1 && promo[0]?.kind === "title_change", JSON.stringify(promo));
  check(
    "…and the same title spelled differently is not",
    detectJobChanges(baseline([snap("Stripe", { title: "Sr. PM" })]), [role("Stripe", { title: "sr pm" })]).length === 0
  );

  const first = detectJobChanges({ hasBaseline: false, roles: [], recentlyLeft: new Set() }, [role("Ramp")]);
  check("a first-ever capture is not a move", first.length === 0);

  const stale = detectJobChanges(baseline([snap("Ramp", { startYear: 2025 })]), [
    role("Ramp", { startYear: 2025 }),
    role("Stripe", { startYear: 2019 }),
  ]);
  check("a stale snippet (current role older than the stored one) is not a join", stale.length === 0, JSON.stringify(stale));

  const flap = detectJobChanges(baseline([snap("Ramp", { startYear: null })], ["stripe"]), [role("Stripe", { startYear: null })]);
  check("back onto an employer they just left is not a join", flap.length === 0, JSON.stringify(flap));

  const left = detectJobChanges(baseline([snap("Stripe")]), [role("Stripe", { isCurrent: false, endYear: 2026, endMonth: 6 })]);
  check("an old role that now shows an end is a departure", left.length === 1 && left[0]?.kind === "left", JSON.stringify(left));

  const missing = detectJobChanges(baseline([snap("Stripe")]), [role("MIT", { kind: "education", isCurrent: false })]);
  check("a role the search simply did not surface is NOT a departure", missing.length === 0, JSON.stringify(missing));

  const again = detectJobChanges(baseline([snap("Stripe")]), [role("Ramp", { title: "Staff PM", startYear: 2026 })]);
  check("the same move detected twice has the same dedupe key", again[0]?.dedupeKey === joined[0]?.dedupeKey);
}

async function recording() {
  console.log("\nRecording, through a real research run");
  await reset();
  const db = await getDb();
  const now = new Date();
  const [contact] = await db
    .insert(contacts)
    .values({
      userId: USER,
      fullName: "Priya Rao",
      linkedinUrl: "https://www.linkedin.com/in/priya-rao",
      company: "Stripe",
      title: "PM",
    })
    .returning();
  const id = contact!.id;

  const answer = (experiences: IncomingExperience[]): WorkHistoryResearcher => async () => ({
    confident: true,
    headline: null,
    sources: [],
    experiences,
  });
  const moved = [
    role("Ramp", { title: "Staff PM", startYear: now.getFullYear(), startMonth: now.getMonth() + 1 }),
    role("Stripe", { isCurrent: false, startYear: 2019, endYear: now.getFullYear() }),
  ];

  // The contact's own company is the baseline when no history is stored yet.
  const outcome = await researchContactWorkHistory(USER, id, { researcher: answer(moved), now });
  check("the research run saved", outcome === "saved", outcome);

  const logged = await db.select().from(contactCareerMoves).where(eq(contactCareerMoves.contactId, id));
  check("the move is logged", logged.length === 1 && logged[0]?.kind === "joined" && logged[0]?.toOrg === "Ramp", JSON.stringify(logged));

  const after = await db.query.contacts.findFirst({ where: eq(contacts.id, id) });
  check("the contact's company follows the move", after?.company === "Ramp", String(after?.company));
  check("…and its title", after?.title === "Staff PM", String(after?.title));

  const timeline = await db
    .select()
    .from(interactions)
    .where(and(eq(interactions.contactId, id), eq(interactions.interactionType, "job_change")));
  check("the timeline has a job-change entry", timeline.length === 1, String(timeline.length));
  check("…that is not a touch (no closeness, no last-contacted)", !isLoggedTouch(timeline[0]!));
  check(
    "…and did not move last-interaction",
    after?.lastInteractionAt === null || after?.lastInteractionAt === undefined,
    String(after?.lastInteractionAt)
  );

  const nudges = await db
    .select()
    .from(aiSuggestions)
    .where(and(eq(aiSuggestions.userId, USER), eq(aiSuggestions.suggestionType, JOB_CHANGE_SUGGESTION_TYPE)));
  check("a congratulations suggestion is offered", nudges.length === 1 && nudges[0]!.title.includes("Ramp"), JSON.stringify(nudges.map((n) => n.title)));

  // The same answer again: the snapshot now matches, and the log's dedupe key holds anyway.
  await researchContactWorkHistory(USER, id, { researcher: answer(moved), now, force: true });
  const loggedAgain = await db.select().from(contactCareerMoves).where(eq(contactCareerMoves.contactId, id));
  const nudgesAgain = await db
    .select()
    .from(aiSuggestions)
    .where(and(eq(aiSuggestions.userId, USER), eq(aiSuggestions.suggestionType, JOB_CHANGE_SUGGESTION_TYPE)));
  check("re-checking does not log the move twice", loggedAgain.length === 1, String(loggedAgain.length));
  check("…or suggest it twice", nudgesAgain.length === 1, String(nudgesAgain.length));

  const lines = await getRecentMoveLines(USER, [id]);
  check("chat and the brief get a recent-moves line", /Joined Ramp as Staff PM/.test(lines.get(id) ?? ""), lines.get(id));
  const opener = await recentMoveAsFieldChanges(USER, id);
  check(
    "the extension's opener sees the move as a company + title change",
    opener.some((c) => c.field === "company" && c.to === "Ramp") && opener.some((c) => c.field === "title" && c.to === "Staff PM"),
    JSON.stringify(opener)
  );

  // An old move found late: logged, but no "congrats" on a job started years ago.
  const [late] = await db
    .insert(contacts)
    .values({ userId: USER, fullName: "Old News", linkedinUrl: "https://www.linkedin.com/in/old-news", company: "Initech" })
    .returning();
  await researchContactWorkHistory(USER, late!.id, {
    researcher: answer([role("Acme", { startYear: 2021 }), role("Initech", { isCurrent: false, endYear: 2021 })]),
    now,
  });
  const lateLog = await db.select().from(contactCareerMoves).where(eq(contactCareerMoves.contactId, late!.id));
  const lateNudge = await db
    .select()
    .from(aiSuggestions)
    .where(and(eq(aiSuggestions.userId, USER), eq(aiSuggestions.suggestionType, JOB_CHANGE_SUGGESTION_TYPE)));
  check("a move found years late is still logged", lateLog.length === 1);
  check("…but not offered as a congratulations", lateNudge.length === 1, String(lateNudge.length));

  // No baseline at all: the first history fills title/company without calling it a move.
  const [blank] = await db
    .insert(contacts)
    .values({ userId: USER, fullName: "Blank Slate", linkedinUrl: "https://www.linkedin.com/in/blank" })
    .returning();
  await researchContactWorkHistory(USER, blank!.id, { researcher: answer([role("Figma", { title: "Designer" })]), now });
  const blankAfter = await db.query.contacts.findFirst({ where: eq(contacts.id, blank!.id) });
  const blankLog = await db.select().from(contactCareerMoves).where(eq(contactCareerMoves.contactId, blank!.id));
  check("a first history fills in the company", blankAfter?.company === "Figma", String(blankAfter?.company));
  check("…without logging a move", blankLog.length === 0);

  await reset();
}

async function main() {
  detection();
  await recording();
  console.log("\nsmoke-job-changes: all checks passed");
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
