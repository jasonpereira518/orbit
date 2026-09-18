/**
 * Seed a realistically large network so the contacts surface can be exercised at the size
 * it was rebuilt for.
 *
 * The demo fixture is a handful of contacts, which is exactly the size at which every
 * performance problem here is invisible. A real LinkedIn export is thousands.
 *
 *   npx tsx scripts/seed-scale.ts --user demo-user 1000    add 1000, keep what is there
 *   npx tsx scripts/seed-scale.ts --user demo-user --remove   take those 1000 back out
 *   npx tsx scripts/seed-scale.ts --user scale-test 5000 --reset   wipe first, then seed
 *
 * ## Why the default stopped being destructive
 *
 * Seeding used to DELETE every contact, interaction and tag link the target account had,
 * unconditionally, as its first act. That made it unusable for the one thing it exists for.
 * Measuring the constellation at scale means measuring the account you can actually open in
 * a browser — in demo mode that is `demo-user` — and running this against `demo-user` meant
 * destroying the seeded demo network that everything else in the repo is exercised against.
 * So it did not get run, and two performance claims in this repo's history rest on reasoning
 * about the shape of the work rather than on a number, because the measurement was blocked
 * by its own tool.
 *
 * The default now ADDS. Every row it writes is stamped `source = 'scale-seed'`, and
 * `--remove` deletes exactly those rows and nothing else, so a 1000-contact measurement is a
 * seed, a run, and a clean-up that leaves the demo network exactly as it found it.
 *
 * `--reset` keeps the old behaviour for a throwaway account, explicitly and on purpose.
 *
 * `--user` is REQUIRED and there is no default, which is what stops an absent-minded run
 * from picking a victim for you.
 */
import { config } from "dotenv";
config({ path: ".env.local" });
config();

import { eq, sql } from "drizzle-orm";
import { getDb } from "../src/db";
import { contactTags, contacts, interactions, tags } from "../src/db/schema";
import { recalibrateCloseness } from "../src/lib/closeness-cohort";
import { scaleContactRows } from "./lib/scale-fixture";

/**
 * What every row this script writes is marked with.
 *
 * The whole point of the additive default: `--remove` can delete precisely the rows this
 * seeded and leave a hand-made network untouched, because provenance is recorded rather
 * than inferred from the name or the creation time.
 */
const SCALE_SOURCE = "scale-seed";

const args = process.argv.slice(2);
const userFlagIndex = args.findIndex((a) => a === "--user");
const userArg = userFlagIndex >= 0 ? args[userFlagIndex + 1] : undefined;
const RESET = args.includes("--reset");
const REMOVE = args.includes("--remove");
if (!userArg) {
  console.error(
    "Missing --user <id>.\n" +
      "  Default is additive: it adds contacts and deletes nothing.\n" +
      "  --remove  takes back out only what this script seeded (source = 'scale-seed').\n" +
      "  --reset   DELETES every contact and interaction on the account first.\n" +
      "  e.g.  --user demo-user 1000        then  --user demo-user --remove"
  );
  process.exit(1);
}
if (RESET && REMOVE) {
  console.error("--reset and --remove are contradictory; pick one.");
  process.exit(1);
}
// Narrowed for the rest of the file; `process.exit` above is not a type guard.
const USER: string = userArg;
const positional = args.filter(
  (a, i) =>
    a !== "--user" && a !== "--reset" && a !== "--remove" && i !== userFlagIndex + 1
);
const COUNT = Number(positional[0] ?? 5000);
const INSERT_CHUNK = 500;

const TAGS = ["mentor","investor","alum","conference","warm intro","hiring","advisor","friend"];
const DAY = 86400000;

async function main() {
  const db = await getDb();

  if (REMOVE) {
    // Scoped to this script's own rows. Interactions and tag links carry ON DELETE CASCADE
    // from `contacts`, so removing the contacts takes their children with them; the eight
    // tag NAMES are left alone because they may well have existed before this ran.
    const removed = await db
      .delete(contacts)
      .where(sql`${contacts.userId} = ${USER} and ${contacts.source} = ${SCALE_SOURCE}`)
      .returning();
    console.log(`Removed ${removed.length} seeded contacts from ${USER}.`);
    const left = await db.query.contacts.findMany({ where: eq(contacts.userId, USER) });
    console.log(`  ${left.length} contacts remain — anything not seeded by this script.`);
    console.log("Recalibrating closeness…");
    await recalibrateCloseness(USER);
    process.exit(0);
  }

  if (RESET) {
    console.log(`--reset: clearing ALL existing ${USER} contacts…`);
    await db.delete(contactTags).where(
      sql`${contactTags.contactId} in (select id from contacts where user_id = ${USER})`
    );
    await db.delete(interactions).where(eq(interactions.userId, USER));
    await db.delete(contacts).where(eq(contacts.userId, USER));
  } else {
    const existing = await db.query.contacts.findMany({
      where: eq(contacts.userId, USER),
      columns: { id: true },
    });
    console.log(
      `Adding to ${USER}, which already has ${existing.length} contacts (nothing will be deleted).`
    );
  }

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
  // Stamped so `--remove` can find exactly these again. Applied here rather than inside
  // `scaleContactRows`, which is shared with `smoke-page-budgets` and should keep producing
  // byte-identical rows for it.
  const fixture = scaleContactRows(USER, COUNT).map((row) => ({
    ...row,
    source: SCALE_SOURCE,
  }));
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

  console.log(
    `\nSeeded ${createdIds.length} contacts, ${links.length} tags, ${touches.length} interactions.`
  );
  console.log(`Take them back out with:  npx tsx scripts/seed-scale.ts --user ${USER} --remove`);
  // tsx keeps the loop alive on PGlite's workers without this.
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
