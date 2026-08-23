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
import { config } from "dotenv";
config({ path: ".env.local" });
config();

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
    // Credentials that must not outlive the account.
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

  await db.insert(schema.interactions).values({
    userId: USER,
    contactId: contact.id,
    interactionType: "note",
    rawNotes: "private note about a real person",
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

  return { recruiterId: recruiter.id };
}

async function main() {
  const tables = userScopedTables();
  console.log(`Seeding one row in each of ${tables.length} user-scoped tables…`);

  // Start clean in case a previous run died mid-way.
  await purgeUserData(USER).catch(() => {});
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
    const remaining = await countFor(name);
    if (remaining === 0) {
      console.log(`  ok  ${name} is empty`);
    } else {
      console.log(`  LEAK  ${name} still has ${remaining} row(s)`);
      leaked += 1;
    }
  }
  check("no user-scoped table retains rows", leaked === 0, `${leaked} table(s) leaked`);

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
