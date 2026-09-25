/**
 * The localhost demo workspace: `ensureLocalDemoData` fills an empty account on `next dev`
 * and nowhere else, never touches an account that has contacts, seeds once under
 * concurrent first requests, and leaves every surface populated.
 *
 * Run: npx tsx scripts/smoke-demo-data.ts
 */
import "./smoke/_env";

import { and, count, eq, inArray, sql } from "drizzle-orm";
import type { AnyPgColumn, PgTable } from "drizzle-orm/pg-core";
import { getDb } from "../src/db";
import {
  actionItems,
  apiKeys,
  chatThreads,
  closenessCohorts,
  companies,
  contactBriefs,
  contactExperiences,
  contactOpportunities,
  contacts,
  events,
  gmailConnections,
  imports,
  interactionMentions,
  interactions,
  meetingSessions,
  meetingTranscriptSegments,
  noteBatches,
  outlookConnections,
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
import { DEMO_CAPTURES, DEMO_OPPORTUNITIES } from "../src/lib/demo-data/network-extra";
import { buildExtendedCast } from "../src/lib/demo-data/seed-extended";
import { ensureUserSettings } from "../src/lib/user-settings";
import { resolveRecruiterPii } from "../src/lib/recruiters";
import { needsOnboarding } from "../src/lib/onboarding";

const FRESH = "smoke-demo-fresh";
const REMOTE_USER = "smoke-demo-remote";
const EXISTING = "smoke-demo-existing";
/** A second local account, seeded later onto the recruiter rows FRESH created. */
const SECOND = "smoke-demo-second";
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
  const users = [FRESH, REMOTE_USER, EXISTING, SECOND];
  for (const table of [
    suggestedReminders, reminders, reminderLists, outreachCampaigns, events, chatThreads,
    recruiterMessages, userRecruiterLinks, imports, userGoals, contacts, companies, tags,
    closenessCohorts, noteBatches, meetingSessions, apiKeys, userSettings,
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
  for (const u of [FRESH, REMOTE_USER, EXISTING, SECOND]) await ensureUserSettings(u);

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
    // Localhost seeds the extended workspace: the cast with fuller histories, plus the long tail.
    const cast = buildExtendedCast();
    const people = cast.people;
    const seeded = await contactCount(FRESH);
    check(`seeded the whole network (${people.length})`, seeded === people.length, String(seeded));
    check("the network is the cast plus a long tail", people.length >= DEMO_PEOPLE.length + 50, String(people.length));
    await ensureLocalDemoData(FRESH);
    check("a later request does not re-seed", (await contactCount(FRESH)) === people.length);

    const rows = (table: PgTable, userIdColumn: AnyPgColumn) => rowsFor(table, userIdColumn, FRESH);
    const captureTouches = DEMO_CAPTURES.reduce((n, c) => n + c.participants.length, 0);
    const expectedTouches = people.reduce((n, p) => n + (p.touches?.length ?? 0), 0) + captureTouches;
    check("every touch is on a timeline", (await rows(interactions, interactions.userId)) === expectedTouches);

    // Everyone in the hand-written cast has a real history, bar the one the landing page
    // shows as drifting (one coffee, nothing since) and two deliberately dormant ties.
    const timelineLength = (p: (typeof people)[number]) =>
      (p.touches?.length ?? 0) + DEMO_CAPTURES.filter((c) => c.participants.includes(p.fullName)).length;
    const thin = cast.people
      .slice(0, DEMO_PEOPLE.length)
      .filter((p) => timelineLength(p) < 3)
      .map((p) => p.fullName);
    check("the cast have multi-event timelines", thin.length <= 3, thin.join(", "));
    const deepest = Math.max(...cast.people.map((p) => p.touches?.length ?? 0));
    check("the closest relationships run deep", deepest >= 8, String(deepest));

    const photographed = await db
      .select({ n: count() })
      .from(contacts)
      .where(and(eq(contacts.userId, FRESH), sql`${contacts.profileImageUrl} like 'https://%'`));
    const withPhoto = Number(photographed[0]?.n ?? 0);
    check("most contacts have a portrait", withPhoto >= people.length * 0.8, `${withPhoto}/${people.length}`);
    check("…but not every one", withPhoto < people.length);
    const unreserved = people.filter((p) => p.email && !/@([a-z0-9-]+\.)*example(\.[a-z]+)?$/.test(p.email));
    check("every seeded email is on a reserved example domain", unreserved.length === 0, unreserved.map((p) => p.email).join(", "));

    check("notes that name people link them", (await rows(interactionMentions, interactionMentions.userId)) >= 20);
    check("captures are in the history", (await rows(noteBatches, noteBatches.userId)) === DEMO_CAPTURES.length);
    check("a recorded meeting has its transcript", (await rows(meetingSessions, meetingSessions.userId)) === 1 && (await rows(meetingTranscriptSegments, meetingTranscriptSegments.userId)) > 3);
    check("opportunities seeded", (await rows(contactOpportunities, contactOpportunities.userId)) === DEMO_OPPORTUNITIES.length);
    check("API keys seeded", (await rows(apiKeys, apiKeys.userId)) === 2);

    check("every contact has a brief", (await rows(contactBriefs, contactBriefs.userId)) === people.length);
    check("work history seeded", (await rows(contactExperiences, contactExperiences.userId)) > people.length);
    check("open action items seeded", (await rows(actionItems, actionItems.userId)) > 0);
    check("reminders seeded", (await rows(reminders, reminders.userId)) >= 8);
    check("a capture awaits review", (await rows(suggestedReminders, suggestedReminders.userId)) === 2);
    check("outreach campaigns seeded", (await rows(outreachCampaigns, outreachCampaigns.userId)) === 2);
    check("recruiter links seeded", (await rows(userRecruiterLinks, userRecruiterLinks.userId)) === 3);
    check("events seeded", (await rows(events, events.userId)) === 4);
    check("chat threads seeded", (await rows(chatThreads, chatThreads.userId)) === 3);
    check("import history seeded", (await rows(imports, imports.userId)) === 6);
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
    check("the setup wizard is done", Boolean(settings?.wizardCompletedAt));
    check("the terms are accepted", Boolean(settings?.termsAcceptedAt && settings.termsVersion));
    check("the calendar feed is on", Boolean(settings?.calendarFeedToken));
    // Display-only connections: the extended seed must never store an OAuth grant.
    check("no Gmail grant is stored", !(await db.query.gmailConnections.findFirst({ where: eq(gmailConnections.userId, FRESH) })));
    check("no Outlook grant is stored", !(await db.query.outlookConnections.findFirst({ where: eq(outlookConnections.userId, FRESH) })));
    check("the onboarding gate lets them through", !(await needsOnboarding(FRESH)));

    console.log("\nrecruiter contact details, first and later accounts");
    // Contact details unlock only for a row's creator (`isCreatorLink`). The seed reuses the
    // global recruiter rows, so each account's own link must carry the details — otherwise a
    // later account reads "Contact locked" and has no email to draft to.
    const demoRows = await db.select().from(recruiters).where(inArray(recruiters.emailNormalized, DEMO_RECRUITER_EMAILS));
    check("the seed made the three demo recruiters", demoRows.length === 3, String(demoRows.length));
    const seenBy = async (userId: string) => {
      const links = await db
        .select()
        .from(userRecruiterLinks)
        .where(eq(userRecruiterLinks.userId, userId));
      const byId = new Map(links.map((l) => [l.recruiterId, l]));
      const rows = await db.select().from(recruiters).where(inArray(recruiters.emailNormalized, DEMO_RECRUITER_EMAILS));
      return rows.filter((r) => resolveRecruiterPii(r, byId.get(r.id) ?? null, false).email).length;
    };
    check("the first account sees their details", (await seenBy(FRESH)) === 3, String(await seenBy(FRESH)));
    await ensureLocalDemoData(SECOND);
    const reused = await db.select().from(recruiters).where(inArray(recruiters.emailNormalized, DEMO_RECRUITER_EMAILS));
    check("a later account reuses the rows rather than duplicating them", reused.length === 3, String(reused.length));
    check("…and still sees their details", (await seenBy(SECOND)) === 3, String(await seenBy(SECOND)));
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
