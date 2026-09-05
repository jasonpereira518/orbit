/**
 * Asserts `purgeUserData` leaves nothing behind, table by table.
 *
 * This exists because the same bug class has bitten twice: `outlook_connections` and
 * `suggested_reminders` both carried `user_id`, both looked like they would be covered by
 * something else, and both silently survived account deletion — one holding encrypted OAuth
 * refresh tokens, the other holding excerpts of the user's own notes.
 *
 * The table list is DERIVED from the schema at runtime rather than hand-written, so a new
 * user-scoped table added later fails this test until it is either purged explicitly or
 * covered by a cascade. That is the whole point — a hand-maintained list would have the
 * same blind spot as the code it is checking.
 *
 * Run: npx tsx scripts/smoke-purge.ts
 */
import "./smoke/_env";

import { eq, getTableColumns, getTableName, sql } from "drizzle-orm";
import { PgTable } from "drizzle-orm/pg-core";
import { getDb, rowsOf } from "../src/db";
import * as schema from "../src/db/schema";
import { purgeUserData } from "../src/lib/user-data";

const USER = "smoke-purge-user";

function check(label: string, condition: boolean, detail?: string) {
  if (!condition) throw new Error(`${label} failed${detail ? `: ${detail}` : ""}`);
  console.log(`  ok  ${label}`);
}

/** Every exported pgTable that carries a `user_id` column. */
function userScopedTables(): Array<{ name: string; table: PgTable }> {
  const found: Array<{ name: string; table: PgTable }> = [];
  for (const value of Object.values(schema)) {
    if (!(value instanceof PgTable)) continue;
    const columns = getTableColumns(value);
    if (!("userId" in columns)) continue;
    found.push({ name: getTableName(value), table: value });
  }
  return found.sort((a, b) => a.name.localeCompare(b.name));
}

async function countFor(tableName: string) {
  const db = await getDb();
  const result = await db.execute(
    sql.raw(
      `SELECT count(*)::int AS n FROM ${tableName} WHERE user_id = '${USER}'`
    )
  );
  return rowsOf<{ n: number }>(result)[0]?.n ?? 0;
}

async function seed() {
  const db = await getDb();
  const now = new Date();

  await db.insert(schema.userSettings).values({
    userId: USER,
    email: `${USER}@example.test`,
    // The BYO provider key is a deliberate survivor of purge — see `purgeUserData`.
    // The calendar feed token is not, and must not outlive the account.
    geminiApiKeyEncrypted: "ciphertext",
    calendarFeedToken: "feed-token",
  });

  const [company] = await db
    .insert(schema.companies)
    .values({ userId: USER, name: "Acme", nameNormalized: "acme" })
    .returning();

  const [contact] = await db
    .insert(schema.contacts)
    .values({ userId: USER, fullName: "Ada Lovelace", companyId: company.id })
    .returning();

  const [tag] = await db
    .insert(schema.tags)
    .values({ userId: USER, name: "friend" })
    .returning();
  await db.insert(schema.contactTags).values({ contactId: contact.id, tagId: tag.id });

  await db.insert(schema.userGoals).values({ userId: USER, text: "meet more people" });

  const [feedbackRow] = await db
    .insert(schema.feedback)
    .values({
      userId: USER,
      kind: "churn_reason",
      text: "their own words about Orbit",
    })
    .returning();

  // Carries `user_id` of its own rather than relying on the cascade from `feedback` —
  // which is exactly why `userScopedTables()` finds it, and why it needs a row here.
  await db.insert(schema.feedbackScreenshots).values({
    feedbackId: feedbackRow.id,
    userId: USER,
    storage: "inline",
    inlineData: "aGVsbG8=",
    contentType: "image/webp",
    byteSize: 5,
  });

  await db.insert(schema.gateEvents).values({
    userId: USER,
    feature: "contacts",
    plan: "free",
  });

  // Anonymised rather than deleted on purge — see `purgeUserData`. The count below is
  // `WHERE user_id = USER`, so nulling the column satisfies the no-leak check honestly.
  await db.insert(schema.billingEvents).values({
    source: "clerk",
    eventId: `${USER}-evt`,
    kind: "new",
    userId: USER,
    mrrDeltaCents: 500,
    effectiveAt: now,
  });

  await db.insert(schema.closenessCohorts).values({
    userId: USER,
    snapshot: {
      n: 1,
      evidencedN: 1,
      coverage: 1,
      relativeWeight: 0,
      quantiles: [0.5],
      averageRaw: 0.5,
      maxCompany: 1,
      maxSchool: 1,
      userDomain: null,
      mailConnected: false,
    },
    contactCount: 1,
  });

  const [interaction] = await db
    .insert(schema.interactions)
    .values({
      userId: USER,
      contactId: contact.id,
      interactionType: "note",
      rawNotes: "private note about a real person",
    })
    .returning();

  // The pasted text a note was parsed out of. Nothing cascades this — both
  // `note_batch_id` columns are plain uuids with no foreign key — so it only leaves with
  // the explicit delete in `purgeUserData`.
  await db.insert(schema.noteBatches).values({
    userId: USER,
    sourceHash: "note-batch-hash",
    sourceText: "the raw notes the user pasted, about named people",
    anchorDate: now,
    result: {} as never,
  });

  // Cascade-covered (from `contacts` / `interactions`), seeded anyway: the cascade is the
  // thing under test, and an unseeded table proves nothing about it.
  await db.insert(schema.contactBriefs).values({
    userId: USER,
    contactId: contact.id,
    standing: "a generated summary of a real relationship",
  });

  // Cascade-covered (from `contacts`), seeded anyway: the cascade is the thing under test,
  // and an unseeded table proves nothing about it. Holds the prose half of a captured
  // LinkedIn profile — headline, about, skills — for a real named person.
  await db.insert(schema.contactProfiles).values({
    userId: USER,
    contactId: contact.id,
    headline: "Computer Scientist at Acme",
    source: "extension",
  });

  // Cascade-covered (from `contacts`), seeded anyway, same reasoning as `contactProfiles`
  // above. Holds one role/school entry from that same captured profile.
  await db.insert(schema.contactExperiences).values({
    userId: USER,
    contactId: contact.id,
    kind: "role",
    organization: "Acme",
    organizationNormalized: "acme",
    source: "extension",
  });

  await db.insert(schema.actionItems).values({
    userId: USER,
    contactId: contact.id,
    interactionId: interaction.id,
    text: "send them the deck",
    itemHash: "action-item-hash",
  });

  await db.insert(schema.interactionMentions).values({
    userId: USER,
    interactionId: interaction.id,
    contactId: contact.id,
    mentionText: "Ada",
    confidence: 0.9,
    matchedBy: "exact_name",
  });

  const [list] = await db
    .insert(schema.reminderLists)
    .values({ userId: USER, name: "Inbox", nameNormalized: "inbox" })
    .returning();

  const [reminder] = await db
    .insert(schema.reminders)
    .values({
      userId: USER,
      contactId: contact.id,
      listId: list.id,
      title: "follow up",
      dueDate: now,
    })
    .returning();

  // The FKs below are `on delete set null`, so this row outlives both of them.
  await db.insert(schema.suggestedReminders).values({
    userId: USER,
    contactId: contact.id,
    reminderId: reminder.id,
    captureBatchId: crypto.randomUUID(),
    title: "coffee next week",
    rawDatePhrase: "next week",
    dueDate: now,
    sourceExcerpt: "an excerpt of the user's own notes",
    sourceHash: "hash-a",
    itemHash: "hash-b",
  });

  const [importJob] = await db
    .insert(schema.imports)
    .values({ userId: USER, importType: "linkedin_connections" })
    .returning();

  await db.insert(schema.importJobRows).values({
    importId: importJob.id,
    userId: USER,
    rowIndex: 0,
    payload: {} as never,
  });

  await db.insert(schema.calendarSubscriptions).values({
    userId: USER,
    icsUrl: "https://example.test/feed.ics",
  });

  await db.insert(schema.aiSuggestions).values({
    userId: USER,
    suggestionType: "reconnect",
    title: "Reach out",
  });

  await db.insert(schema.outreachCampaigns).values({ userId: USER, name: "Campaign" });

  await db.insert(schema.contactEmbeddings).values({
    userId: USER,
    contactId: contact.id,
    sourceType: "note",
    embedding: [0.1, 0.2],
    content: "embedded note content",
  });

  const [recruiter] = await db
    .insert(schema.recruiters)
    .values({ fullName: "Rec Ruiter", nameNormalized: "rec ruiter" })
    .returning();
  await db
    .insert(schema.userRecruiterLinks)
    .values({ userId: USER, recruiterId: recruiter.id });

  // Carries the user's own prose to a named third party, plus the Gmail ids that locate it
  // in a real mailbox. Exactly the class of row this suite exists to catch.
  await db.insert(schema.recruiterMessages).values({
    userId: USER,
    recruiterId: recruiter.id,
    intent: "set_up_chat",
    subject: "Following up on the role",
    body: "prose the user wrote about a real person",
  });

  for (const table of [schema.gmailConnections, schema.outlookConnections]) {
    await db.insert(table).values({
      userId: USER,
      emailAddress: `${USER}@example.test`,
      accessTokenEncrypted: "ciphertext-access",
      refreshTokenEncrypted: "ciphertext-refresh",
    });
  }

  const [thread] = await db
    .insert(schema.chatThreads)
    .values({ userId: USER, title: "thread" })
    .returning();
  await db.insert(schema.chatMessages).values({
    threadId: thread.id,
    userId: USER,
    role: "user",
    content: "a private question about my network",
  });

  await db.insert(schema.errorEvents).values({
    userId: USER,
    source: "oauth.gmail.callback",
    kind: "token_exchange_failed",
    message: "system error text",
  });

  await db.insert(schema.usageEvents).values({
    userId: USER,
    operation: "capture.parse",
    provider: "gemini",
    model: "gemini-3.5-flash",
    kind: "completion",
    keyOwner: "user",
  });

  // Per-user rate-limit window for the browser extension. Keyed on user id and nothing
  // else, so it is easy to forget it is personal data at all — which is how it became the
  // fourth user-scoped table to ship unpurged (found the first time this suite ran on a
  // fresh database instead of one that happened to hold a leftover row).
  await db.insert(schema.extensionUsage).values({ userId: USER, requestCount: 3, aiCount: 1 });

  // The connector platform. `api_keys` is the one that would matter most if it survived a
  // deletion: a credential with no owning account still works.
  await db.insert(schema.apiKeys).values({
    userId: USER,
    name: "purge fixture",
    prefix: "orb_live_deadbeef",
    keyHash: "0".repeat(64),
    scopes: ["read"],
  });
  await db.insert(schema.apiIdempotencyKeys).values({
    userId: USER,
    idempotencyKey: "purge-fixture",
    requestHash: "abc",
    statusCode: 200,
    responseBody: {},
  });
  const [endpoint] = await db
    .insert(schema.webhookEndpoints)
    .values({
      userId: USER,
      url: "https://example.com/hook",
      secretEncrypted: "enc",
      eventTypes: ["contact.created"],
      status: "active",
    })
    .returning();
  await db.insert(schema.outboundWebhookDeliveries).values({
    userId: USER,
    endpointId: endpoint.id,
    eventId: "evt_purge_fixture",
    eventType: "contact.created",
    payload: {},
  });

  return { recruiterId: recruiter.id };
}

async function main() {
  const tables = userScopedTables();
  console.log(`Seeding one row in each of ${tables.length} user-scoped tables…`);

  // Start clean in case a previous run died mid-way. The billing row needs deleting by
  // hand: purge anonymises it rather than removing it, so it survives its own cleanup and
  // the unique `(source, event_id)` index would reject the next run's insert.
  await purgeUserData(USER).catch(() => {});
  await (await getDb())
    .delete(schema.billingEvents)
    .where(eq(schema.billingEvents.eventId, `${USER}-evt`))
    .catch(() => {});
  const { recruiterId } = await seed();

  console.log("\nSeeded");
  const seededCounts = new Map<string, number>();
  for (const { name } of tables) {
    const n = await countFor(name);
    seededCounts.set(name, n);
  }
  const unseeded = tables.filter(({ name }) => (seededCounts.get(name) ?? 0) === 0);
  check(
    "every user-scoped table has a row to delete",
    unseeded.length === 0,
    `not seeded: ${unseeded.map((t) => t.name).join(", ")}`
  );

  console.log("\nPurging");
  await purgeUserData(USER);

  let leaked = 0;
  for (const { name } of tables) {
    // Asserted separately below: the BYO provider key is a deliberate survivor (see
    // `purgeUserData`), so this table legitimately keeps a row under the same user id.
    if (name === "user_settings") continue;
    const remaining = await countFor(name);
    if (remaining === 0) {
      console.log(`  ok  ${name} is empty`);
    } else {
      console.log(`  LEAK  ${name} still has ${remaining} row(s)`);
      leaked += 1;
    }
  }
  check("no user-scoped table retains rows", leaked === 0, `${leaked} table(s) leaked`);

  // The one table that is anonymised rather than deleted. Asserting the row SURVIVES is
  // as important as asserting the others are gone: if a future edit "tidies" this into a
  // delete, the no-leak sweep above would still pass and Orbit would quietly lose its
  // accounting history every time a customer left.
  const ledgerDb = await getDb();
  const kept = await ledgerDb
    .select()
    .from(schema.billingEvents)
    .where(eq(schema.billingEvents.eventId, `${USER}-evt`));
  check("billing_events survives the purge", kept.length === 1);
  check("...with the personal link severed", kept[0]?.userId === null);
  check("...and the money intact", kept[0]?.mrrDeltaCents === 500);
  await ledgerDb
    .delete(schema.billingEvents)
    .where(eq(schema.billingEvents.eventId, `${USER}-evt`));

  // The second deliberate survivor — see `purgeUserData`. Asserting BOTH halves matters:
  // the key surviving alone would miss a purge that forgot to delete-and-recreate the row,
  // and the row surviving without the key check would miss a purge that kept everything.
  const settingsAfterPurge = await ledgerDb.query.userSettings.findFirst({
    where: eq(schema.userSettings.userId, USER),
  });
  check("user_settings survives the purge", Boolean(settingsAfterPurge));
  check(
    "...with the BYO API key intact",
    settingsAfterPurge?.geminiApiKeyEncrypted === "ciphertext"
  );
  check(
    "...but the calendar feed token cleared",
    settingsAfterPurge?.calendarFeedToken === null
  );
  await ledgerDb
    .delete(schema.userSettings)
    .where(eq(schema.userSettings.userId, USER));

  // `keepSettings: false` — the admin console's hard delete — must leave nothing behind,
  // including the fields the default path above deliberately preserves.
  await ledgerDb.insert(schema.userSettings).values({
    userId: USER,
    email: `${USER}@example.test`,
    geminiApiKeyEncrypted: "ciphertext",
  });
  await purgeUserData(USER, { keepSettings: false });
  const settingsAfterHardDelete = await ledgerDb.query.userSettings.findFirst({
    where: eq(schema.userSettings.userId, USER),
  });
  check(
    "keepSettings: false leaves no user_settings row at all",
    settingsAfterHardDelete === undefined
  );

  // contact_tags has no user_id of its own, so the derived sweep above cannot see it.
  const db = await getDb();
  const orphanTags = await db.execute(
    sql.raw(
      `SELECT count(*)::int AS n FROM contact_tags ct
       LEFT JOIN contacts c ON c.id = ct.contact_id WHERE c.id IS NULL`
    )
  );
  check(
    "contact_tags leaves no orphans",
    (rowsOf<{ n: number }>(orphanTags)[0]?.n ?? 0) === 0
  );

  // The shared recruiter directory is deliberately NOT user data — it must survive.
  const survivor = await db.query.recruiters.findFirst({
    where: eq(schema.recruiters.id, recruiterId),
  });
  check("the shared recruiters directory survives", Boolean(survivor));
  await db.delete(schema.recruiters).where(eq(schema.recruiters.id, recruiterId));

  console.log("\nAll purge checks passed.");
}

main()
  .then(() => {
    // The pooled DB connection keeps the event loop alive; exit explicitly.
    process.exit(0);
  })
  .catch(async (e) => {
    console.error("\nFAILED:", e.message);
    await purgeUserData(USER).catch(() => {});
    process.exit(1);
  });
