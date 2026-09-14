/**
 * Asserts that a SELECTIVE delete removes exactly what was asked for — no more, no less.
 *
 * `scripts/smoke-purge.ts` covers the full purge and is the one that catches a new
 * user-scoped table. This script covers the other half of the same function: the settings
 * dialog hands `purgeUserData` a subset of `DATA_CATEGORY_IDS`, and the two failures that
 * matter there are opposites of each other —
 *
 *   - deleting MORE than was ticked (a cascade nobody declared), which is unrecoverable and
 *     which the user was never warned about; and
 *   - deleting LESS than was ticked (a step that quietly belongs to another category), which
 *     leaves data behind that someone believes is gone.
 *
 * Both are checked below by seeding every category, deleting one, and asserting the rest are
 * untouched. The cascade from `contacts` is the one place where more-than-ticked is correct,
 * and `DATA_CATEGORY_META.implies` is what makes it declared rather than surprising — so it
 * is asserted in both directions: the expansion happens, and it stops there.
 *
 * Run: npx tsx scripts/smoke-purge-selective.ts
 */
import "./smoke/_env";

import { eq, sql } from "drizzle-orm";
import { getDb, rowsOf } from "../src/db";
import * as schema from "../src/db/schema";
import {
  DATA_CATEGORY_IDS,
  DATA_CATEGORY_META,
  expandCategories,
  lockedByImplication,
  type DataCategory,
} from "../src/lib/data-categories";
import { recomputeRecruiterRating } from "../src/lib/recruiters";
import { getDataFootprint, purgeUserData } from "../src/lib/user-data";

const USER = "smoke-purge-selective-user";

function check(label: string, condition: boolean, detail?: string) {
  if (!condition) throw new Error(`${label} failed${detail ? `: ${detail}` : ""}`);
  console.log(`  ok  ${label}`);
}

async function countFor(tableName: string) {
  const db = await getDb();
  const result = await db.execute(
    sql`SELECT count(*)::int AS n FROM ${sql.identifier(tableName)} WHERE user_id = ${USER}`
  );
  return rowsOf<{ n: number }>(result)[0]?.n ?? 0;
}

/**
 * One row per category, so "was anything else touched?" is answerable by counting. Only the
 * categories with a table of their own are seeded — `preferences` is `user_settings`, which
 * every other check needs to exist, and is asserted separately at the end.
 */
async function seed() {
  const db = await getDb();
  const now = new Date();

  await db.insert(schema.userSettings).values({
    userId: USER,
    email: `${USER}@example.test`,
    geminiApiKeyEncrypted: "ciphertext",
    calendarFeedToken: "feed-token",
    // `recomputeRecruiterRating` only counts links whose owner opted into the shared pool,
    // so without this the counter is 0 before and after and the check below proves nothing.
    recruiterSharing: 1,
  });

  const [contact] = await db
    .insert(schema.contacts)
    .values({ userId: USER, fullName: "Ada Lovelace" })
    .returning();
  const [tag] = await db
    .insert(schema.tags)
    .values({ userId: USER, name: "friend" })
    .returning();
  await db.insert(schema.contactTags).values({ contactId: contact.id, tagId: tag.id });

  await db.insert(schema.interactions).values({
    userId: USER,
    contactId: contact.id,
    interactionType: "note",
    rawNotes: "private note about a real person",
  });
  const [list] = await db
    .insert(schema.reminderLists)
    .values({ userId: USER, name: "Follow-ups", nameNormalized: "follow-ups" })
    .returning();
  await db.insert(schema.reminders).values({
    userId: USER,
    contactId: contact.id,
    listId: list.id,
    title: "follow up",
    dueDate: now,
  });
  await db.insert(schema.aiSuggestions).values({
    userId: USER,
    suggestionType: "reconnect",
    title: "Reach out",
  });
  await db
    .insert(schema.imports)
    .values({ userId: USER, importType: "linkedin_connections" });
  await db.insert(schema.gmailConnections).values({
    userId: USER,
    emailAddress: `${USER}@example.test`,
    accessTokenEncrypted: "ciphertext-access",
    refreshTokenEncrypted: "ciphertext-refresh",
  });
  const [event] = await db
    .insert(schema.events)
    .values({ userId: USER, title: "Deep Learning Summit", venue: "Moscone" })
    .returning();
  await db.insert(schema.userGoals).values({ userId: USER, text: "meet more people" });
  await db.insert(schema.chatThreads).values({ userId: USER, title: "thread" });
  await db.insert(schema.apiKeys).values({
    userId: USER,
    name: "key",
    prefix: "orb_live_selective",
    keyHash: "0".repeat(64),
    scopes: ["read"],
  });
  await db.insert(schema.usageEvents).values({
    userId: USER,
    operation: "capture.parse",
    provider: "gemini",
    model: "gemini-3.5-flash",
    kind: "completion",
    keyOwner: "user",
  });
  await db
    .insert(schema.feedback)
    .values({ userId: USER, kind: "churn_reason", text: "their own words" });
  await db.insert(schema.outreachCampaigns).values({ userId: USER, name: "Campaign" });

  // Tables folded into an existing category by the merge with main's newer feature
  // branches — each seeded here so a step that quietly forgets one, or a step that
  // reaches across a category boundary for one, fails this script rather than shipping.
  await db.insert(schema.meetingSessions).values({ userId: USER, title: "Coffee chat" });
  await db.insert(schema.captureJobs).values({
    userId: USER,
    sourceKind: "messy",
    inputText: "met ada at the summit",
  });
  const [company] = await db
    .insert(schema.companies)
    .values({ userId: USER, name: "Acme", nameNormalized: "acme" })
    .returning();
  await db.insert(schema.contactMerges).values({
    userId: USER,
    winnerContactId: contact.id,
    loserContactId: crypto.randomUUID(),
    loserSnapshot: { fullName: "A. Lovelace" },
  });
  await db.insert(schema.targetCompanies).values({ userId: USER, companyId: company.id });
  await db.insert(schema.eventCompanies).values({
    userId: USER,
    eventId: event.id,
    companyId: company.id,
    role: "sponsor",
    source: "manual",
  });
  await db.insert(schema.recruiterScanState).values({ userId: USER });
  await db.insert(schema.planUpgradeEvents).values({
    userId: USER,
    plan: "orbit",
    source: "subscription",
    eventKey: `${USER}-upgrade`,
  });
  await db.insert(schema.pageViews).values({
    id: crypto.randomUUID(),
    userId: USER,
    visitorHash: "0".repeat(64),
    sessionId: "sess-selective",
    route: "/dashboard",
    device: "desktop",
  });

  // The one row this script writes outside the user's own data. `recruiters` is the shared
  // directory: it must survive, and its denormalized counters must come back down.
  const [recruiter] = await db
    .insert(schema.recruiters)
    .values({
      fullName: "Grace Hopper",
      nameNormalized: "grace hopper",
      firm: "Navy",
    })
    .returning();
  await db.insert(schema.userRecruiterLinks).values({
    userId: USER,
    recruiterId: recruiter.id,
    personalRating: 5,
  });
  await recomputeRecruiterRating(recruiter.id);
  return recruiter.id;
}

/** The headline table for each category, used to prove that category did (not) run. */
const WITNESS: Record<DataCategory, string | null> = {
  insights: "ai_suggestions",
  notes: "interactions",
  reminders: "reminders",
  imports: "imports",
  connections: "gmail_connections",
  events: "events",
  goals: "user_goals",
  chat: "chat_threads",
  recruiters: "user_recruiter_links",
  api: "api_keys",
  activity: "usage_events",
  feedback: "feedback",
  outreach: "outreach_campaigns",
  contacts: "contacts",
  tags: "tags",
  preferences: null,
};

async function witnessCounts() {
  const counts = new Map<DataCategory, number>();
  for (const { id } of DATA_CATEGORY_META) {
    const table = WITNESS[id];
    if (table) counts.set(id, await countFor(table));
  }
  return counts;
}

/** The shared-directory row the current fixture is linked to; re-created by every reset. */
let recruiterId = "";

async function reset() {
  await purgeUserData(USER, { keepSettings: false }).catch(() => {});
  const db = await getDb();
  await db
    .delete(schema.recruiters)
    .where(eq(schema.recruiters.nameNormalized, "grace hopper"));
  recruiterId = await seed();
}

async function main() {
  console.log("The category list itself");
  check(
    "every category has a witness entry",
    DATA_CATEGORY_META.every((c) => c.id in WITNESS)
  );
  check(
    "ids and metadata agree",
    DATA_CATEGORY_IDS.length === DATA_CATEGORY_META.length &&
      new Set(DATA_CATEGORY_IDS).size === DATA_CATEGORY_IDS.length
  );
  check(
    "contacts declares the cascade it causes",
    ["notes", "reminders", "insights"].every((id) =>
      expandCategories(["contacts"]).has(id as DataCategory)
    )
  );
  check(
    "...and the dialog would lock exactly those three",
    lockedByImplication(["contacts"]).size === 3
  );
  check(
    "a category with no cascade expands to itself",
    expandCategories(["chat"]).size === 1
  );

  console.log("\nDeleting one category leaves the rest alone");
  await reset();
  const before = await witnessCounts();
  check(
    "every witness table has a row to delete",
    [...before.values()].every((n) => n > 0),
    [...before.entries()].filter(([, n]) => n === 0).map(([id]) => id).join(", ")
  );

  await purgeUserData(USER, { only: ["chat"] });
  const afterChat = await witnessCounts();
  check("chat is gone", afterChat.get("chat") === 0);
  const collateral = [...afterChat.entries()].filter(
    ([id, n]) => id !== "chat" && n === 0
  );
  check(
    "nothing else was touched",
    collateral.length === 0,
    `also emptied: ${collateral.map(([id]) => id).join(", ")}`
  );

  console.log("\nThe declared cascade, and its limit");
  await reset();
  await purgeUserData(USER, { only: ["contacts"] });
  const afterContacts = await witnessCounts();
  check("contacts is gone", afterContacts.get("contacts") === 0);
  // These three are `on delete cascade` from `contacts`. The dialog ticks and locks them,
  // and the point of asserting it here is that the warning matches the behaviour.
  check("...and interactions went with it", afterContacts.get("notes") === 0);
  check("...and reminders went with it", afterContacts.get("reminders") === 0);
  // `contact_embeddings` cascades; `ai_suggestions` does not, and is deleted because
  // `contacts` implies `insights`. Without the implication this row would survive.
  check("...and the insights it fed", afterContacts.get("insights") === 0);
  // The stop: tags are a vocabulary, not a contact. Deleting everyone must not silently
  // empty the tag list too.
  check("but the tag vocabulary survives", (afterContacts.get("tags") ?? 0) > 0);
  check("as does the import history", (afterContacts.get("imports") ?? 0) > 0);
  check("as do connected accounts", (afterContacts.get("connections") ?? 0) > 0);

  const db = await getDb();
  const orphans = await db.execute(
    sql.raw(
      `SELECT count(*)::int AS n FROM contact_tags ct
       LEFT JOIN contacts c ON c.id = ct.contact_id WHERE c.id IS NULL`
    )
  );
  check(
    "contact_tags leaves no orphans",
    (rowsOf<{ n: number }>(orphans)[0]?.n ?? 0) === 0
  );
  // `contact_merges` and `target_companies` were folded into this step by a later merge —
  // this is what stops a future merge from quietly leaving one of them in the wrong
  // category, or dropping it from any category at all.
  check(
    "...and the merge snapshot went with it",
    (await countFor("contact_merges")) === 0
  );
  check(
    "...and the target company list went with it",
    (await countFor("target_companies")) === 0
  );

  console.log("\nTables folded in by a later merge stay in their own category");
  // A fresh seed, not a continuation of the block above: that block already ran a
  // `contacts` purge, which (via `implies`) already emptied the `notes` step this block
  // is about to probe.
  await reset();
  await purgeUserData(USER, { only: ["chat"] });
  check(
    "an unrelated delete leaves the meeting/capture pipeline alone",
    (await countFor("meeting_sessions")) > 0 && (await countFor("capture_jobs")) > 0
  );
  check(
    "...and the merge/target-company rows",
    (await countFor("contact_merges")) > 0 && (await countFor("target_companies")) > 0
  );
  check("...and event_companies", (await countFor("event_companies")) > 0);
  check(
    "...and the recruiter scan watermark",
    (await countFor("recruiter_scan_state")) > 0
  );
  check(
    "...and the queued upgrade celebration",
    (await countFor("plan_upgrade_events")) > 0
  );

  await purgeUserData(USER, { only: ["notes"] });
  check(
    "notes takes the meeting/capture pipeline with it",
    (await countFor("meeting_sessions")) === 0 && (await countFor("capture_jobs")) === 0
  );

  await purgeUserData(USER, { only: ["events"] });
  check("events takes event_companies with it", (await countFor("event_companies")) === 0);

  await purgeUserData(USER, { only: ["recruiters"] });
  check(
    "recruiters takes the scan watermark with it",
    (await countFor("recruiter_scan_state")) === 0
  );

  // `page_views` is ANONYMISED by the `activity` step, not deleted — asserted the same way
  // `billing_events` is in `scripts/smoke-purge.ts`: the row survives, with `user_id` cleared.
  check(
    "activity has not yet touched page_views",
    (await countFor("page_views")) > 0
  );
  await purgeUserData(USER, { only: ["activity"] });
  const pageViewAfter = await db.query.pageViews.findFirst({
    where: eq(schema.pageViews.sessionId, "sess-selective"),
  });
  check(
    "activity anonymises page_views rather than deleting it",
    Boolean(pageViewAfter) && pageViewAfter?.userId === null
  );
  await db.delete(schema.pageViews).where(eq(schema.pageViews.sessionId, "sess-selective"));
  // Unlike `page_views`, this one has no life outside the account it belongs to — deleted
  // outright, in the same `activity` purge.
  check(
    "activity deletes the upgrade celebration outright",
    (await countFor("plan_upgrade_events")) === 0
  );

  console.log("\nSettings follow the preferences box, not the delete");
  await reset();
  await purgeUserData(USER, { only: ["chat"] });
  const settingsKept = await db.query.userSettings.findFirst({
    where: eq(schema.userSettings.userId, USER),
  });
  check(
    "a delete without preferences leaves settings alone",
    settingsKept?.calendarFeedToken === "feed-token"
  );

  await purgeUserData(USER, { only: ["preferences"] });
  const settingsReset = await db.query.userSettings.findFirst({
    where: eq(schema.userSettings.userId, USER),
  });
  check("preferences resets the row", settingsReset?.calendarFeedToken === null);
  check(
    "...keeping the BYO provider key",
    settingsReset?.geminiApiKeyEncrypted === "ciphertext"
  );
  check(
    "...and the contacts it was not asked to delete",
    (await countFor("contacts")) > 0
  );

  console.log("\nThe shared recruiter directory");
  await reset();
  // `avg_rating` / `rating_count` / `log_count` on `recruiters` are denormalized over
  // `user_recruiter_links`, and nothing recomputes them on delete. Without the recompute
  // inside the `recruiters` step, every deletion permanently inflates them on each
  // recruiter the user had linked — and the drift is invisible, the directory just gets
  // slowly less true. `scripts/smoke-instrumentation.ts` guards that the call still
  // exists; this asserts it runs and lands.
  const ratedBefore = await db.query.recruiters.findFirst({
    where: eq(schema.recruiters.id, recruiterId),
  });
  check("the directory counted the link", ratedBefore?.ratingCount === 1);

  await purgeUserData(USER, { only: ["recruiters"] });
  const ratedAfter = await db.query.recruiters.findFirst({
    where: eq(schema.recruiters.id, recruiterId),
  });
  check("the shared recruiter survives a link delete", Boolean(ratedAfter));
  check(
    "...with its counter recomputed, not left inflated",
    ratedAfter?.ratingCount === 0
  );
  check(
    "...and the rest of the account untouched",
    (await countFor("contacts")) > 0
  );

  console.log("\nEdges");
  await reset();
  await purgeUserData(USER, { only: [] });
  const afterNothing = await witnessCounts();
  check(
    "an empty selection deletes nothing",
    [...afterNothing.values()].every((n) => n > 0)
  );

  const footprint = await getDataFootprint(USER);
  check("the footprint counts what is there", footprint.contacts > 0);
  check("...and reports zero for what it cannot count", footprint.preferences === 0);
  check(
    "...for every category",
    DATA_CATEGORY_META.every(({ id }) => typeof footprint[id] === "number")
  );

  // Selecting everything must be indistinguishable from the full purge — the dialog's
  // "Delete everything" and the Clerk `user.deleted` webhook have to mean the same thing.
  await purgeUserData(USER, { only: DATA_CATEGORY_IDS });
  const afterAll = await witnessCounts();
  check(
    "selecting every category empties every table",
    [...afterAll.values()].every((n) => n === 0)
  );

  await purgeUserData(USER, { keepSettings: false });
  await db.delete(schema.recruiters).where(eq(schema.recruiters.id, recruiterId));
  console.log("\nAll selective-purge checks passed.");
}

main()
  .then(() => {
    // The pooled DB connection keeps the event loop alive; exit explicitly.
    process.exit(0);
  })
  .catch(async (e) => {
    console.error("\nFAILED:", e.message);
    await purgeUserData(USER, { keepSettings: false }).catch(() => {});
    process.exit(1);
  });
