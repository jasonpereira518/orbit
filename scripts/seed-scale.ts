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

const USER = "demo-user";
const COUNT = Number(process.argv[2] ?? 5000);
const INSERT_CHUNK = 500;

const FIRST = ["Ada","Grace","Alan","Katherine","Edsger","Barbara","Donald","Margaret","Linus","Radia","Ken","Frances","Tim","Shafi","Vint","Adele","Bjarne","Anita","Guido","Carol","Yukihiro","Sophie","Rasmus","Jean","Dennis","Hedy","Niklaus","Evelyn","Brian","Mary"];
const LAST = ["Lovelace","Hopper","Turing","Johnson","Dijkstra","Liskov","Knuth","Hamilton","Torvalds","Perlman","Thompson","Allen","Berners-Lee","Goldwasser","Cerf","Goldberg","Stroustrup","Borg","van Rossum","Shaw","Matsumoto","Wilson","Lerdorf","Bartik","Ritchie","Lamarr","Wirth","Boyd","Kernighan","Keller"];
const COMPANIES = ["Acme","Northwind","Globex","Initech","Umbrella","Hooli","Stark Industries","Wayne Enterprises","Cyberdyne","Aperture","Black Mesa","Tyrell","Weyland","Soylent","Massive Dynamic","Pied Piper",null];
const TITLES = ["Engineer","Staff Engineer","Design Lead","Product Manager","Founder","CTO","Recruiter","Data Scientist","Researcher","VP Engineering",null];
const CITIES = ["Toronto","New York","London","Berlin","Lisbon","San Francisco","Austin","Singapore","Nairobi","São Paulo",null];
const SCHOOLS = ["Waterloo","MIT","Cambridge","UofT","Stanford","TU Delft",null];
const TAGS = ["mentor","investor","alum","conference","warm intro","hiring","advisor","friend"];

const pick = <T,>(xs: T[], i: number) => xs[i % xs.length];
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
  for (let start = 0; start < COUNT; start += INSERT_CHUNK) {
    const batch = [];
    for (let i = start; i < Math.min(start + INSERT_CHUNK, COUNT); i++) {
      // Deterministic spread, so a rerun produces the same network.
      const r = ((i * 2654435761) % 100000) / 100000;
      const first = pick(FIRST, i);
      const last = pick(LAST, i * 7 + 3);
      const interacted = r > 0.55;
      batch.push({
        userId: USER,
        fullName: `${first} ${last} ${i}`,
        firstName: first,
        lastName: last,
        company: pick(COMPANIES, i * 3),
        title: pick(TITLES, i * 5),
        location: pick(CITIES, i * 11),
        school: pick(SCHOOLS, i * 13),
        email: r > 0.35 ? `${first.toLowerCase()}.${i}@example.com` : null,
        linkedinUrl: r > 0.4 ? `https://www.linkedin.com/in/${first.toLowerCase()}-${last.toLowerCase().replace(/[^a-z]/g, "")}-${i}/` : null,
        relationshipScore: 1 + Math.floor(r * 5),
        statedCloseness: r > 0.85 ? 1 + Math.floor(r * 5) : null,
        howMet: r > 0.7 ? "Met at a conference" : null,
        aiSummary: r > 0.5 ? `Works on ${pick(TITLES, i) ?? "things"} at ${pick(COMPANIES, i * 3) ?? "an unlisted company"}.` : null,
        notes: r > 0.75 ? "Worth following up on the hiring conversation." : null,
        keyFacts: r > 0.6 ? ["Runs marathons", "Two kids"] : [],
        sharedInterests: r > 0.8 ? ["sailing", "typography"] : [],
        dateMet: new Date(Date.now() - (100 + r * 1500) * DAY),
        lastInteractionAt: interacted ? new Date(Date.now() - r * 400 * DAY) : new Date(Date.now() - 900 * DAY),
        nextFollowUpAt: i % 23 === 0 ? new Date(Date.now() - 3 * DAY) : null,
      });
    }
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
