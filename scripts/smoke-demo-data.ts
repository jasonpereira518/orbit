/**
 * The localhost demo workspace: `ensureLocalDemoData` fills an empty account on `next dev`
 * and nowhere else, never touches an account that has contacts, seeds once under
 * concurrent first requests, and leaves every surface populated.
 *
 * Run: npx tsx scripts/smoke-demo-data.ts
 */
import "./smoke/_env";

import { and, count, eq, inArray } from "drizzle-orm";
import type { AnyPgColumn, PgTable } from "drizzle-orm/pg-core";
import { getDb } from "../src/db";
import {
  actionItems,
  chatThreads,
  closenessCohorts,
  companies,
  contactBriefs,
  contactExperiences,
  contacts,
  events,
  imports,
  interactions,
  outreachCampaigns,
  outreachMessages,
  outreachProspects,
  recruiterMessages,
  recruiters,
  reminderLists,
  reminders,
  suggestedReminders,
  tags,
  userGoals,
  userRecruiterLinks,
  userSettings,
} from "../src/db/schema";
import { ensureLocalDemoData } from "../src/lib/demo-data/ensure";
import { DEMO_PEOPLE } from "../src/lib/demo-data/network";
import { ensureUserSettings } from "../src/lib/user-settings";
import { needsOnboarding } from "../src/lib/onboarding";

const FRESH = "smoke-demo-fresh";
const REMOTE_USER = "smoke-demo-remote";
const EXISTING = "smoke-demo-existing";
const DEMO_RECRUITER_EMAILS = ["alex@riveratalent.example", "morgan.blake@insightglobal.example", "marcus.lee@example.com"];

function check(label: string, condition: boolean, detail?: string) {
  if (!condition) throw new Error(`${label} failed${detail ? `: ${detail}` : ""}`);
  console.log(`  ok  ${label}`);
}

const env = process.env as Record<string, string | undefined>;
function setNodeEnv(value: string | undefined) {
  if (value === undefined) delete env.NODE_ENV;
  else env.NODE_ENV = value;
}

async function rowsFor(table: PgTable, userIdColumn: AnyPgColumn, userId: string) {
  const db = await getDb();
  const [row] = await db.select({ n: count() }).from(table).where(eq(userIdColumn, userId));
  return Number(row?.n ?? 0);
}

const contactCount = (userId: string) => rowsFor(contacts, contacts.userId, userId);

/**
 * The smoke runner shares one PGlite across every script, and several (the ops sweep, the
 * admin roster) scan all users — so this script must leave nothing behind.
 */
async function cleanup() {
  const db = await getDb();
  const users = [FRESH, REMOTE_USER, EXISTING];
  for (const table of [
    suggestedReminders, reminders, reminderLists, outreachCampaigns, events, chatThreads,
    recruiterMessages, userRecruiterLinks, imports, userGoals, contacts, companies, tags,
    closenessCohorts, userSettings,
  ]) {
    await db.delete(table).where(inArray(table.userId, users));
  }
  await db.delete(recruiters).where(inArray(recruiters.emailNormalized, DEMO_RECRUITER_EMAILS));
}

async function main() {
  console.log("Demo workspace smoke test (pglite)…");
  const priorNodeEnv = env.NODE_ENV;
  const priorFlag = env.ORBIT_DEMO_DATA;
  delete env.ORBIT_DEMO_DATA;
  const db = await getDb();
  for (const u of [FRESH, REMOTE_USER, EXISTING]) await ensureUserSettings(u);

  try {
    console.log("\noff localhost");
    setNodeEnv("production");
    await ensureLocalDemoData(REMOTE_USER);
    check("a deployed server seeds nothing", (await contactCount(REMOTE_USER)) === 0);

    console.log("\nopt-out");
    setNodeEnv("development");
    env.ORBIT_DEMO_DATA = "off";
    await ensureLocalDemoData(REMOTE_USER);
    check("ORBIT_DEMO_DATA=off seeds nothing", (await contactCount(REMOTE_USER)) === 0);
    delete env.ORBIT_DEMO_DATA;

    console.log("\nexisting data is never touched");
    await db.insert(contacts).values({ userId: EXISTING, fullName: "Someone Real" });
    await ensureLocalDemoData(EXISTING);
    check("an account with contacts keeps exactly its own", (await contactCount(EXISTING)) === 1);

    console.log("\nempty account on localhost");
    check("fresh account starts in onboarding", await needsOnboarding(FRESH));
    // Three concurrent first requests must produce one workspace, not three.
    await Promise.all([ensureLocalDemoData(FRESH), ensureLocalDemoData(FRESH), ensureLocalDemoData(FRESH)]);
    const seeded = await contactCount(FRESH);
    check(`seeded the whole network (${DEMO_PEOPLE.length})`, seeded === DEMO_PEOPLE.length, String(seeded));
    await ensureLocalDemoData(FRESH);
    check("a later request does not re-seed", (await contactCount(FRESH)) === DEMO_PEOPLE.length);

    const rows = (table: PgTable, userIdColumn: AnyPgColumn) => rowsFor(table, userIdColumn, FRESH);
    const expectedTouches = DEMO_PEOPLE.reduce((n, p) => n + (p.touches?.length ?? 0), 0);
    check("every touch is on a timeline", (await rows(interactions, interactions.userId)) === expectedTouches);

    check("every contact has a brief", (await rows(contactBriefs, contactBriefs.userId)) === DEMO_PEOPLE.length);
    check("work history seeded", (await rows(contactExperiences, contactExperiences.userId)) > DEMO_PEOPLE.length);
    check("open action items seeded", (await rows(actionItems, actionItems.userId)) > 0);
    check("reminders seeded", (await rows(reminders, reminders.userId)) >= 8);
    check("a capture awaits review", (await rows(suggestedReminders, suggestedReminders.userId)) === 2);
    check("outreach campaigns seeded", (await rows(outreachCampaigns, outreachCampaigns.userId)) === 2);
    check("recruiter links seeded", (await rows(userRecruiterLinks, userRecruiterLinks.userId)) === 3);
    check("events seeded", (await rows(events, events.userId)) === 4);
    check("chat threads seeded", (await rows(chatThreads, chatThreads.userId)) === 2);
    check("import history seeded", (await rows(imports, imports.userId)) === 1);
    check("goals seeded", (await rows(userGoals, userGoals.userId)) === 3);

    // Demo data must never be picked up by a sender: a `scheduled` or `queued` row is.
    const campaignIds = (
      await db.select({ id: outreachCampaigns.id }).from(outreachCampaigns).where(eq(outreachCampaigns.userId, FRESH))
    ).map((c) => c.id);
    const sendable = await db
      .select({ id: outreachMessages.id })
      .from(outreachMessages)
      .innerJoin(outreachProspects, eq(outreachProspects.id, outreachMessages.prospectId))
      .where(and(inArray(outreachProspects.campaignId, campaignIds), inArray(outreachMessages.status, ["scheduled", "queued"])));
    check("no seeded outreach message is waiting to send", sendable.length === 0, String(sendable.length));
    const queuedRecruiter = await db
      .select({ id: recruiterMessages.id })
      .from(recruiterMessages)
      .where(and(eq(recruiterMessages.userId, FRESH), inArray(recruiterMessages.status, ["queued"])));
    check("no seeded recruiter email is queued", queuedRecruiter.length === 0);

    const settings = await db.query.userSettings.findFirst({ where: eq(userSettings.userId, FRESH) });
    check("onboarding is complete", Boolean(settings?.onboardingCompletedAt));
    check("the onboarding gate lets them through", !(await needsOnboarding(FRESH)));
  } finally {
    setNodeEnv(priorNodeEnv);
    await cleanup();
    if (priorFlag === undefined) delete env.ORBIT_DEMO_DATA;
    else env.ORBIT_DEMO_DATA = priorFlag;
  }

  console.log("\nAll demo workspace checks passed.");
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error("\nFAILED:", e);
    process.exit(1);
  });
