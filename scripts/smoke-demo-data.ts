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
  connectorConnections,
  contactBriefs,
  contactExperiences,
  contacts,
  crmRecords,
  events,
  imports,
  interactions,
  leads,
  outreachCampaigns,
  outreachMessages,
  outreachProspects,
  recruiterMessages,
  recruiters,
  reminderLists,
  reminders,
  suggestedReminders,
  tags,
  teamMembers,
  teams,
  userGoals,
  userRecruiterLinks,
  userSettings,
} from "../src/db/schema";
import { ensureLocalDemoData } from "../src/lib/demo-data/ensure";
import { DEMO_CRM_PEOPLE } from "../src/lib/demo-data/crm";
import { DEMO_PEOPLE } from "../src/lib/demo-data/network";
import { DEMO_LEADS, DEMO_TEAM_DOMAIN, DEMO_TEAMMATE_CONTACTS, DEMO_TEAMMATES, demoTeamAllowed } from "../src/lib/demo-data/team";
import { workContactsCondition } from "../src/lib/crm/work-contacts";
import { loadPipeline } from "../src/lib/leads/pipeline";
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
  const users = [FRESH, REMOTE_USER, EXISTING, SECOND, ...DEMO_TEAMMATES.map((m) => m.userId)];
  for (const table of [
    crmRecords, connectorConnections, leads, teamMembers,
    suggestedReminders, reminders, reminderLists, outreachCampaigns, events, chatThreads,
    recruiterMessages, userRecruiterLinks, imports, userGoals, contacts, companies, tags,
    closenessCohorts, userSettings,
  ]) {
    await db.delete(table).where(inArray(table.userId, users));
  }
  await db.delete(recruiters).where(inArray(recruiters.emailNormalized, DEMO_RECRUITER_EMAILS));
  await db.delete(teams).where(eq(teams.domain, DEMO_TEAM_DOMAIN));
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

    console.log("\nthe demo team");
    check(
      "the demo team is never seeded into a shared database",
      !demoTeamAllowed({ DATABASE_URL: "postgres://shared.example/orbit" }) && demoTeamAllowed({})
    );
    const pipeline = await loadPipeline(FRESH);
    check("the demo account is on a sharing team", pipeline.team === "ok", pipeline.team);
    const handLeads = pipeline.rows.filter((r) => r.lead.source !== "crm");
    check(`the demo leads are seeded (${DEMO_LEADS.length})`, handLeads.length === DEMO_LEADS.length, String(handLeads.length));
    const warmthOf = new Map(handLeads.map((r) => [r.lead.displayName, r.path?.warmth ?? "none"]));
    check(
      "the leads land on every rung of the ladder",
      DEMO_LEADS.every((l) => warmthOf.get(l.displayName) === l.expected),
      JSON.stringify([...warmthOf])
    );

    console.log("\nthe demo HubSpot");
    const [crmConn] = await db.select().from(connectorConnections).where(and(eq(connectorConnections.userId, FRESH), eq(connectorConnections.connectorId, "hubspot")));
    check("a demo HubSpot connection exists", crmConn?.accountRef === "orbit-demo" && crmConn?.label === "orbit-demo.hubspot.com");
    check("it is never armed for the scheduler", crmConn?.nextSyncAt === null);
    check("it holds no token", crmConn?.accessTokenEncrypted === null && crmConn?.refreshTokenEncrypted === null);
    const customers = DEMO_CRM_PEOPLE.filter((p) => p.lifecycle === "customer");
    const work = await db.select({ id: contacts.id }).from(contacts).where(and(eq(contacts.userId, FRESH), workContactsCondition(FRESH)));
    check(`the ${customers.length} customers are work contacts`, work.length === customers.length, String(work.length));
    for (const p of customers) {
      const matches = await db.select().from(contacts).where(and(eq(contacts.userId, FRESH), eq(contacts.email, p.email)));
      check(`${p.displayName} is one contact, not two`, matches.length === 1, String(matches.length));
    }
    const crmLeads = pipeline.rows.filter((r) => r.lead.source === "crm");
    check("the CRM leads joined the pipeline", crmLeads.length === DEMO_CRM_PEOPLE.length - customers.length, String(crmLeads.length));
    check("one of them has a warm path through the team", crmLeads.some((r) => r.path?.warmth === "cool" || r.path?.warmth === "warm" || r.path?.warmth === "hot"));
    check("each CRM lead links to its HubSpot record", crmLeads.every((r) => r.crm?.label === "HubSpot" && r.crm.url.startsWith("https://app.hubspot.com/")));
    check("the demo HubSpot is never seeded into a shared database", !demoTeamAllowed({ DATABASE_URL: "postgres://shared.example/orbit" }));

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

    const alex = DEMO_TEAMMATES[0].userId;
    const alexContacts = await rowsFor(contacts, contacts.userId, alex);
    check(
      "a later account reuses the demo colleagues",
      alexContacts === DEMO_TEAMMATE_CONTACTS.filter((c) => c.teammate === alex).length,
      String(alexContacts)
    );
    check("…and joins the same team", (await loadPipeline(SECOND)).team === "ok");
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
