/**
 * Seed a realistically large network so the contacts surface can be exercised at the size
 * it was rebuilt for.
 *
 * The demo fixture is a handful of contacts, which is exactly the size at which every
 * performance problem here is invisible. A real LinkedIn export is thousands.
 *
 * Run: npx tsx scripts/seed-scale.ts [count]
 */
import { config } from "dotenv";
config({ path: ".env.local" });
config();

import { eq, sql } from "drizzle-orm";
import { getDb } from "../src/db";
import { contactTags, contacts, interactions, tags } from "../src/db/schema";
import { recalibrateCloseness } from "../src/lib/closeness-cohort";
import { scaleContactRows } from "./lib/scale-fixture";

const USER = "demo-user";
const COUNT = Number(process.argv[2] ?? 5000);
const INSERT_CHUNK = 500;

const TAGS = ["mentor","investor","alum","conference","warm intro","hiring","advisor","friend"];
const DAY = 86400000;

async function main() {
  const db = await getDb();

  console.log(`Clearing existing ${USER} contacts…`);
  await db.delete(contactTags).where(
    sql`${contactTags.contactId} in (select id from contacts where user_id = ${USER})`
  );
  await db.delete(interactions).where(eq(interactions.userId, USER));
  await db.delete(contacts).where(eq(contacts.userId, USER));

  const tagIds: string[] = [];
  for (const name of TAGS) {
    const existing = await db.query.tags.findFirst({
      where: sql`${tags.userId} = ${USER} and ${tags.name} = ${name}`,
    });
    if (existing) tagIds.push(existing.id);
    else {
      const [row] = await db.insert(tags).values({ userId: USER, name }).returning();
      tagIds.push(row.id);
    }
  }

  console.log(`Inserting ${COUNT} contacts…`);
  const createdIds: string[] = [];
  const fixture = scaleContactRows(USER, COUNT);
  for (let start = 0; start < COUNT; start += INSERT_CHUNK) {
    const batch = fixture.slice(start, start + INSERT_CHUNK);
    // Plain `.returning()`: getDb() is a union of the neon and pglite drivers, and the
    // partial-shape overload does not resolve across both.
    const rows = await db.insert(contacts).values(batch).returning();
    createdIds.push(...rows.map((r) => r.id));
    process.stdout.write(`\r  ${createdIds.length}/${COUNT}`);
  }
  console.log("");

  console.log("Attaching tags…");
  const links = createdIds.flatMap((id, i) =>
    i % 4 === 0 ? [{ contactId: id, tagId: tagIds[i % tagIds.length] }] : []
  );
  for (let i = 0; i < links.length; i += INSERT_CHUNK) {
    await db.insert(contactTags).values(links.slice(i, i + INSERT_CHUNK));
  }

  console.log("Logging interactions…");
  const touches = createdIds.flatMap((id, i) => {
    const r = ((i * 2654435761) % 100000) / 100000;
    if (r <= 0.55) return [];
    return Array.from({ length: 1 + (i % 4) }, (_, k) => ({
      userId: USER,
      contactId: id,
      interactionType: "note",
      interactionDate: new Date(Date.now() - (k * 40 + r * 300) * DAY),
      rawNotes: "Caught up briefly.",
    }));
  });
  for (let i = 0; i < touches.length; i += INSERT_CHUNK) {
    await db.insert(interactions).values(touches.slice(i, i + INSERT_CHUNK));
    process.stdout.write(`\r  ${Math.min(i + INSERT_CHUNK, touches.length)}/${touches.length}`);
  }
  console.log("");

  console.log("Recalibrating closeness…");
  const started = Date.now();
  const result = await recalibrateCloseness(USER);
  console.log(
    `  scored ${result.byId.size} contacts in ${((Date.now() - started) / 1000).toFixed(1)}s`
  );

  console.log(`\nSeeded ${createdIds.length} contacts, ${links.length} tags, ${touches.length} interactions.`);
  // tsx keeps the loop alive on PGlite's workers without this.
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
