/**
 * Report (and, with --apply, upgrade) stored contact photos that are too small.
 *
 * The same pass the app runs in the background on an idle avatar-backfill tick
 * (`src/lib/avatar-upgrade.ts`), run by hand: it finds inline JPEG photos whose shorter edge
 * is under SOFT_AVATAR_PX, from a source the pass may replace (public / extension / unknown),
 * on a contact with a LinkedIn profile, and re-fetches a bigger copy through the usual tier
 * ladder (LinkedIn public page, then Unavatar, then Microlink). A photo is replaced only by a
 * strictly larger, cleanly decoded one. Uploads and Google / Outlook / Gravatar / Apollo
 * photos, tour examples, Blob URLs and non-JPEGs are never touched.
 *
 * DRY RUN by default: reads photo headers from the database and counts. It makes NO network
 * request and writes NOTHING. --apply does real lookups, subject to the per-source quota
 * reserves, and stops at the first rate limit.
 *
 * --user <id>   limit to one account
 * --limit N     dry run: stop after reading N photo headers. apply: stop after N lookups.
 *
 * Run: npx tsx scripts/upgrade-soft-avatars.ts [--apply] [--user <userId>] [--limit N]
 */
import { config } from "dotenv";
config({ path: ".env.local" });
config();

import { and, eq, like, sql } from "drizzle-orm";
import { getDb, rowsOf } from "../src/db";
import { contacts } from "../src/db/schema";
import {
  AVATAR_UPGRADE_COOLDOWN_DAYS,
  SOFT_AVATAR_PX,
  findUpgradeScan,
  isSoftEdge,
  measureInlineJpeg,
  minEdge,
  runAvatarUpgradePass,
  upgradeCandidateWhere,
} from "../src/lib/avatar-upgrade";

const apply = process.argv.includes("--apply");
const argValue = (flag: string) => {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const userId = argValue("--user");
const limitArg = argValue("--limit");
const limit = limitArg ? Math.max(1, Math.floor(Number(limitArg)) || 0) : Infinity;
const BATCH = 100;

async function count(db: Awaited<ReturnType<typeof getDb>>, where: ReturnType<typeof and>) {
  const [r] = await db.select({ n: sql<number>`count(*)::int` }).from(contacts).where(where);
  return r?.n ?? 0;
}

async function dryRun(db: Awaited<ReturnType<typeof getDb>>) {
  let after: string | undefined;
  let examined = 0;
  let fine = 0;
  let unreadable = 0;
  const softBySource = new Map<string, number>();
  const softUsers = new Set<string>();

  scan: for (;;) {
    const rows = await findUpgradeScan(db, { userId, limit: BATCH, afterId: after });
    if (rows.length === 0) break;
    after = rows[rows.length - 1].id;
    for (const row of rows) {
      if (examined >= limit) break scan;
      examined++;
      const dim = measureInlineJpeg(row.head);
      if (!dim) unreadable++;
      else if (isSoftEdge(minEdge(dim))) {
        const key = row.source ?? "unknown";
        softBySource.set(key, (softBySource.get(key) ?? 0) + 1);
        softUsers.add(row.userId);
      } else fine++;
    }
  }

  const eligible = await count(db, upgradeCandidateWhere({ userId }));
  const withCooldownIgnored = await count(db, upgradeCandidateWhere({ userId, cooldown: false }));
  const protectedSources = await count(
    db,
    and(
      userId ? eq(contacts.userId, userId) : undefined,
      like(contacts.profileImageUrl, "data:image/jpeg%"),
      sql`${contacts.profileImageSource} IN ('upload', 'google', 'outlook', 'gravatar', 'apollo')`
    )
  );
  const soft = [...softBySource.values()].reduce((a, b) => a + b, 0);

  console.log(`Dry run (no network, nothing written): read ${examined} of ${eligible} eligible inline JPEG photo header(s).`);
  console.log(`  soft (shorter edge under ${SOFT_AVATAR_PX}px): ${soft}, across ${softUsers.size} account(s)`);
  for (const [source, n] of [...softBySource].sort((a, b) => b[1] - a[1])) {
    console.log(`    stored source ${source}: ${n}`);
  }
  console.log("    would be re-fetched from: the contact's LinkedIn profile via LinkedIn public page -> Unavatar -> Microlink");
  console.log(`  fine (${SOFT_AVATAR_PX}px or more): ${fine}`);
  console.log(`  header unreadable: ${unreadable}`);
  console.log(`  held back by the ${AVATAR_UPGRADE_COOLDOWN_DAYS}-day cooldown (not read): ${withCooldownIgnored - eligible}`);
  console.log(`  never touched, source is upload/google/outlook/gravatar/apollo: ${protectedSources}`);
  if (soft > 0) console.log("Re-run with --apply to look up bigger copies (uses Unavatar/Microlink quota within its reserves).");
}

async function applyUpgrades(db: Awaited<ReturnType<typeof getDb>>) {
  const users = userId
    ? [userId]
    : rowsOf<{ user_id: string }>(
        await db.execute(sql`SELECT DISTINCT user_id FROM contacts WHERE ${upgradeCandidateWhere({})} ORDER BY user_id`)
      ).map((r) => r.user_id);

  let attempted = 0;
  let upgraded = 0;
  let stopped: string | null = null;
  for (const uid of users) {
    for (;;) {
      if (attempted >= limit || stopped) break;
      const r = await runAvatarUpgradePass(db, uid, { batchSize: Math.min(10, limit - attempted) });
      attempted += r.attempted;
      upgraded += r.upgraded;
      if (r.stopped) {
        stopped = r.stopped;
        break;
      }
      // Nothing left to read, or only photos this pass could not act on.
      if (r.examined === 0 || (r.attempted === 0 && r.soft === 0)) break;
    }
    if (attempted >= limit || stopped) break;
  }
  console.log(`Applied: ${attempted} lookup(s), ${upgraded} photo(s) upgraded${stopped ? `; stopped early: ${stopped}` : ""}.`);
}

async function main() {
  const db = await getDb();
  if (apply) await applyUpgrades(db);
  else await dryRun(db);
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
