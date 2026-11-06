/**
 * The SQL that classifies a stored photo reads only the prefix of an inline one, and still
 * gives exactly the answers it gave before (LATENCY_PLAN SRV-16, DB-4).
 *
 * `clientAvatarUrlSql` (every list, dashboard and graph scan) and the backfill's
 * `needsWorkPredicate` (POST /api/contacts/avatar-backfill, fired on every page load) used to
 * test `btrim(profile_image_url)` first, which decompressed every inline base64 photo, up to
 * 120 KB each. They now test an 11-character `substr` for `data:image/` first. This pins both
 * to the previous expressions over every kind of stored value, and checks that a scan over
 * large inline photos stays fast.
 *
 * Runs against a throwaway PGlite. Run: npx tsx scripts/smoke-avatar-sql-classify.ts
 */
import "./smoke/_env";
import { run } from "./smoke/_env";

import { eq, sql } from "drizzle-orm";
import { getDb, rowsOf } from "../src/db";
import { contacts } from "../src/db/schema";
import { clientAvatarUrlSql } from "../src/lib/contact-avatar-sql";
import { countAvatarBackfillCandidates, findAvatarBackfillCandidates } from "../src/lib/avatar-backfill";
import { NO_PHOTO_PREFIX } from "../src/lib/contact-avatar-url";
import { notTourExample } from "../src/lib/onboarding-examples/sql";

const USER = "avatar-sql-classify-user";

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

const BIG_DATA_URL = `data:image/jpeg;base64,${"QUJD".repeat(30_000)}`; // ~120 KB

/** The stored values the classifiers distinguish, including the awkward ones. */
const VALUES: (string | null)[] = [
  null,
  "",
  "   ",
  "data:image/png;base64,iVBORw0KGgo=",
  BIG_DATA_URL,
  " data:image/png;base64,iVBORw0KGgo=", // leading space: never matched the data branch
  "data:text/plain;base64,aGk=",
  `${NO_PHOTO_PREFIX}1700000000000`,
  "https://abc.public.blob.vercel-storage.com/avatars/x.jpg",
  "https://unavatar.io/linkedin/someone",
  "https://static.licdn.com/aero-v1/sc/h/placeholder.png",
  "https://media.licdn.com/dms/image/v2/photo.jpg",
  "  https://media.licdn.com/dms/image/v2/padded.jpg  ",
];

run(async () => {
  const db = await getDb();
  await db.delete(contacts).where(eq(contacts.userId, USER));
  for (const [i, v] of VALUES.entries()) {
    await db.insert(contacts).values({
      userId: USER,
      fullName: `Classify ${i}`,
      profileImageUrl: v,
      linkedinUrl: i % 2 ? `https://www.linkedin.com/in/classify-${i}` : null,
      email: i % 3 ? null : `classify-${i}@example.com`,
    });
  }

  console.log("clientAvatarUrlSql gives the previous expression's answer for every stored value...");
  {
    // The expression before this change, verbatim apart from the shared-photo coalesce
    // (unchanged and out of scope here: none of these contacts has a shared photo).
    const rows = rowsOf<{ id: string; now: string | null; before: string | null }>(
      await db.execute(sql`
        SELECT ${contacts.id} AS id,
               ${clientAvatarUrlSql} AS now,
               coalesce(NULL, CASE
                 WHEN ${contacts.profileImageUrl} IS NULL OR btrim(${contacts.profileImageUrl}) = '' THEN NULL
                 WHEN ${contacts.profileImageUrl} LIKE ${NO_PHOTO_PREFIX + "%"} THEN NULL
                 WHEN ${contacts.profileImageUrl} LIKE 'data:image/%' THEN '/api/avatars/' || ${contacts.id}
                 WHEN ${contacts.profileImageUrl} LIKE '%unavatar.io%'
                   OR ${contacts.profileImageUrl} LIKE '%static.licdn.com/aero%' THEN NULL
                 ELSE btrim(${contacts.profileImageUrl})
               END) AS before
          FROM ${contacts}
         WHERE ${contacts.userId} = ${USER}
      `)
    );
    const diff = rows.filter((r) => r.now !== r.before);
    check(`identical for all ${rows.length} values`, rows.length === VALUES.length && diff.length === 0, JSON.stringify(diff));
  }

  console.log("\nThe backfill picks the same contacts as the previous predicate...");
  {
    const before = rowsOf<{ id: string }>(
      await db.execute(sql`
        SELECT id::text AS id FROM contacts
         WHERE user_id = ${USER}
           AND (
             ((linkedin_url IS NOT NULL AND btrim(linkedin_url) <> '') OR (email IS NOT NULL AND btrim(email) <> ''))
             AND (CASE
               WHEN profile_image_url IS NULL OR btrim(profile_image_url) = '' THEN 'none'
               WHEN profile_image_url LIKE 'data:image/%' THEN 'durable'
               WHEN profile_image_url LIKE '%.public.blob.vercel-storage.com%' THEN 'durable'
               WHEN profile_image_url LIKE '%unavatar.io%' OR profile_image_url LIKE '%static.licdn.com/aero%' THEN 'unusable'
               ELSE 'remote' END) IN ('none', 'unusable')
             AND profile_image_checked_at IS NULL
             AND ${notTourExample(sql`source`)}
           OR (CASE
               WHEN profile_image_url IS NULL OR btrim(profile_image_url) = '' THEN 'none'
               WHEN profile_image_url LIKE 'data:image/%' THEN 'durable'
               WHEN profile_image_url LIKE '%.public.blob.vercel-storage.com%' THEN 'durable'
               WHEN profile_image_url LIKE '%unavatar.io%' OR profile_image_url LIKE '%static.licdn.com/aero%' THEN 'unusable'
               ELSE 'remote' END) = 'remote')
         ORDER BY id
      `)
    ).map((r) => r.id);
    const now = (await findAvatarBackfillCandidates(db, USER, { limit: 100, skipIds: [] })).map((c) => c.id).sort();
    const count = await countAvatarBackfillCandidates(db, USER, []);
    check("same candidates", JSON.stringify(now) === JSON.stringify([...before].sort()), `${now.length} vs ${before.length}`);
    check("same backlog count", count === before.length, `${count} vs ${before.length}`);
  }

  console.log("\nA scan over many large inline photos stays fast...");
  {
    await db.execute(sql`
      INSERT INTO contacts (user_id, full_name, profile_image_url, linkedin_url)
      SELECT ${USER}, 'Inline ' || g, ${BIG_DATA_URL}, 'https://www.linkedin.com/in/inline-' || g
        FROM generate_series(1, 400) g
    `);
    const t = performance.now();
    await Promise.all([
      findAvatarBackfillCandidates(db, USER, { limit: 5, skipIds: [] }),
      countAvatarBackfillCandidates(db, USER, []),
    ]);
    const ms = performance.now() - t;
    // Decompressing all 400 photos (48 MB of base64) took ~1.1 s here; the prefix read takes
    // ~6 ms. The bound sits far from both so a slow CI machine cannot flake it.
    check("the backfill probe over 400 inline photos takes under 300 ms", ms < 300, `${Math.round(ms)} ms`);
  }

  await db.delete(contacts).where(eq(contacts.userId, USER));
  console.log(failures === 0 ? "\nAll avatar SQL classification checks passed." : `\n${failures} check(s) FAILED.`);
  if (failures) process.exit(1);
});
