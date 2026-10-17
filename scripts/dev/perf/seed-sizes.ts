/**
 * The performance audit's fixture (PERFORMANCE_AUDIT.md): seeds ONE PGlite directory
 * (ORBIT_PGLITE_DIR, never the dev server's) for demo-user at size N.
 *   N=0     -> empty account (settings row only)
 *   N>0     -> demo workspace (25 rich people w/ timelines, reminders) + (N-25) scale contacts
 * Interactions: ~3 per scale contact (bench pattern), tags on 25%, reminders on 2%.
 *   ORBIT_DEMO_DATA=off ORBIT_PGLITE_DIR=$(mktemp -d) npx tsx scripts/dev/perf/seed-sizes.ts 10000
 * Copy the seeded directory before each measurement so every run starts from the same state.
 */
import { sql } from "drizzle-orm";
import { getDb, closeDb, rowsOf } from "../../../src/db";
import { contacts, contactTags, interactions, reminders, tags } from "../../../src/db/schema";
import { ensureUserSettings } from "../../../src/lib/user-settings";
import { seedDemoWorkspace } from "../../../src/lib/demo-data/seed";
import { recalibrateCloseness } from "../../../src/lib/closeness-cohort";
import { scaleContactRows } from "../../lib/scale-fixture";

const USER = "demo-user";
const N = Number(process.argv[2]);
const TYPES = ["email", "meeting", "note", "linkedin_message", "call"];
const TAGS = ["mentor", "investor", "alum", "conference", "warm intro", "hiring", "advisor", "friend"];
const DAY = 86_400_000;
const CHUNK = 1000;

async function main() {
  const t0 = Date.now();
  const db = await getDb();
  await ensureUserSettings(USER);
  if (N === 0) {
    console.log("empty account");
    return;
  }
  await seedDemoWorkspace(USER);
  const scaleN = Math.max(0, N - 25);
  const rows = scaleContactRows(USER, scaleN, {
    inlineAvatarShare: 0.02,
    longNotesShare: 0.3,
    dueFollowUpRows: [Math.floor(scaleN * 0.9)],
  }).map((r) => ({ ...r, source: "scale-seed" }));
  const ids: string[] = [];
  for (let s = 0; s < rows.length; s += CHUNK) {
    const ins = await db.insert(contacts).values(rows.slice(s, s + CHUNK)).returning();
    ids.push(...ins.map((r) => r.id));
    if (s % 10000 === 0) process.stdout.write(`\rcontacts ${ids.length}/${scaleN}`);
  }
  console.log(`\ncontacts done ${((Date.now() - t0) / 1000).toFixed(1)}s`);

  const tagIds: string[] = [];
  for (const name of TAGS) {
    const [row] = await db.insert(tags).values({ userId: USER, name }).onConflictDoNothing().returning();
    if (row) tagIds.push(row.id);
  }
  const links = ids.flatMap((id, i) => (i % 4 === 0 && tagIds.length ? [{ contactId: id, tagId: tagIds[i % tagIds.length] }] : []));
  for (let s = 0; s < links.length; s += CHUNK) await db.insert(contactTags).values(links.slice(s, s + CHUNK));

  let nInter = 0;
  for (let s = 0; s < ids.length; s += 2000) {
    const touches = ids.slice(s, s + 2000).flatMap((contactId, j) => {
      const i = s + j;
      return Array.from({ length: i % 7 }, (_, k) => ({
        userId: USER,
        contactId,
        interactionType: TYPES[(i + k) % TYPES.length],
        interactionDate: new Date(Date.now() - ((i * 13 + k * 29) % 400) * DAY),
        summary: `Touch ${k} with contact ${i}`,
        externalId: `perf-${i}-${k}`,
      }));
    });
    for (let c = 0; c < touches.length; c += CHUNK) await db.insert(interactions).values(touches.slice(c, c + CHUNK));
    nInter += touches.length;
  }
  console.log(`interactions ${nInter} done ${((Date.now() - t0) / 1000).toFixed(1)}s`);

  const rems = ids.flatMap((contactId, i) =>
    i % 50 === 0
      ? [{ userId: USER, contactId, title: `Follow up ${i}`, dueDate: new Date(Date.now() + ((i % 60) - 20) * DAY) }]
      : []
  );
  for (let s = 0; s < rems.length; s += CHUNK) await db.insert(reminders).values(rems.slice(s, s + CHUNK));

  const rc = Date.now();
  const res = await recalibrateCloseness(USER);
  console.log(`recalibrateCloseness: ${res.byId.size} contacts in ${Date.now() - rc} ms`);
  await db.execute(sql`ANALYZE`);
  const [{ c }] = rowsOf<{ c: number }>(await db.execute(sql`select count(*)::int c from contacts where user_id = ${USER}`));
  console.log(`DONE N=${N}: contacts=${c} interactions=${nInter} reminders=${rems.length} total ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}

main()
  .then(async () => {
    await closeDb();
    process.exit(0);
  })
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
