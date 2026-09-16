/**
 * Holds the avatar predicates and their SQL mirrors to the same answers.
 *
 * `clientContactAvatarUrl` and `isUnusableAvatarUrl` live in `contact-avatar-url.ts`, and two
 * SQL expressions reproduce them so a list scan never has to select `profile_image_url` —
 * a column that holds up to 120 KB of base64 per contact. Both mirrors carry a comment
 * telling you to keep them in step, and both drifted anyway: the `orbit:no-photo:` negative-
 * cache marker was taught to the JS and to neither mirror.
 *
 * What that cost, before this test existed:
 *   - `clientAvatarUrlSql` fell through to its ELSE and returned the marker itself, so the
 *     graph and the dashboard rendered `<img src="orbit:no-photo:1757…">` — a broken image
 *     exactly where the initials fallback belongs.
 *   - `storedKind` classified it `'remote'`, so the backfill queued every known-photoless
 *     contact as a remote photo to cache, which sorts AHEAD of LinkedIn lookups, is retried
 *     every run, and can never succeed.
 *
 * A comment cannot enforce a mirror. This asserts it, over the same inputs, in the database.
 *
 * Runs against the local PGlite database. Run: npx tsx scripts/smoke-avatar-sql-parity.ts
 */
import "./smoke/_env";

import { eq } from "drizzle-orm";
import { getDb } from "../src/db";
import { contacts } from "../src/db/schema";
import { clientAvatarUrlSql } from "../src/lib/contact-avatar-sql";
import { avatarBacklogKindSql } from "../src/lib/avatar-backfill";
import {
  NO_PHOTO_TTL_MS,
  clientContactAvatarUrl,
  hasFreshNoPhotoMarker,
  isUnusableAvatarUrl,
  noPhotoMarker,
} from "../src/lib/contact-avatar-url";

const USER = "smoke-avatar-parity-user";

let failures = 0;
function check(label: string, ok: boolean, detail?: string) {
  if (ok) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.error(`  FAIL ${label}${detail ? `\n       ${detail}` : ""}`);
  }
}

const FRESH_MARKER = noPhotoMarker();
const STALE_MARKER = noPhotoMarker(new Date(Date.now() - NO_PHOTO_TTL_MS - 60_000));
const MALFORMED_MARKER = "orbit:no-photo:not-a-number";
const INLINE = "data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAg=";

/** label -> stored value. Every avatar shape the app actually writes. */
const CASES: Array<[string, string | null]> = [
  ["null", null],
  ["empty", "   "],
  ["inline data url", INLINE],
  ["durable blob url", "https://x.public.blob.vercel-storage.com/a.jpg"],
  ["plain remote url", "https://media.licdn.com/photo.jpg"],
  ["unavatar (rate-limited host)", "https://unavatar.io/x"],
  ["licdn aero placeholder", "https://static.licdn.com/aero/x.png"],
  ["fresh no-photo marker", FRESH_MARKER],
  ["stale no-photo marker", STALE_MARKER],
  ["malformed no-photo marker", MALFORMED_MARKER],
];

async function main() {
  const db = await getDb();
  await db.delete(contacts).where(eq(contacts.userId, USER));

  const inserted = await db
    .insert(contacts)
    .values(
      CASES.map(([label, url]) => ({
        userId: USER,
        fullName: label,
        profileImageUrl: url,
      }))
    )
    .returning();
  const idByLabel = new Map(inserted.map((c) => [c.fullName, c.id]));

  const rows = await db
    .select({
      id: contacts.id,
      label: contacts.fullName,
      sqlUrl: clientAvatarUrlSql,
      sqlKind: avatarBacklogKindSql,
    })
    .from(contacts)
    .where(eq(contacts.userId, USER));
  const byLabel = new Map(rows.map((r) => [r.label, r]));

  console.log("\nthe client avatar URL agrees in both languages");
  for (const [label, stored] of CASES) {
    const id = idByLabel.get(label)!;
    const js = clientContactAvatarUrl(id, stored);
    const fromSql = byLabel.get(label)?.sqlUrl ?? null;
    check(
      `${label}: ${JSON.stringify(js)}`,
      js === fromSql,
      `js ${JSON.stringify(js)} vs sql ${JSON.stringify(fromSql)}`
    );
  }

  console.log("\nthe marker never reaches the browser as an image source");
  for (const marker of [FRESH_MARKER, STALE_MARKER, MALFORMED_MARKER]) {
    const label = CASES.find(([, v]) => v === marker)![0];
    check(
      `${label} resolves to no photo`,
      byLabel.get(label)?.sqlUrl === null,
      `got ${JSON.stringify(byLabel.get(label)?.sqlUrl)}`
    );
  }
  check(
    "and the JS predicate says the same",
    [FRESH_MARKER, STALE_MARKER, MALFORMED_MARKER].every((m) => isUnusableAvatarUrl(m))
  );

  console.log("\nthe backfill classifier honours the negative cache and its expiry");
  const kind = (label: string) => byLabel.get(label)?.sqlKind;
  check("null is none", kind("null") === "none");
  check("empty is none", kind("empty") === "none");
  check("an inline data url is durable", kind("inline data url") === "durable");
  check("a blob url is durable", kind("durable blob url") === "durable");
  check("a plain remote url is remote", kind("plain remote url") === "remote");
  check(
    "a rate-limited host is unusable",
    kind("unavatar (rate-limited host)") === "unusable"
  );

  check(
    "a FRESH marker is its own kind, not a remote photo to download",
    kind("fresh no-photo marker") === "no_photo",
    `got ${kind("fresh no-photo marker")} — 'remote' is the bug this test exists for`
  );
  check(
    "a STALE marker reads as none, so the negative cache expires",
    kind("stale no-photo marker") === "none",
    `got ${kind("stale no-photo marker")}`
  );
  check(
    "a malformed marker reads as none rather than breaking the query",
    kind("malformed no-photo marker") === "none",
    `got ${kind("malformed no-photo marker")}`
  );

  console.log("\nand the TTL matches the JS predicate");
  check("fresh, in both languages", hasFreshNoPhotoMarker(FRESH_MARKER));
  check("stale, in both languages", !hasFreshNoPhotoMarker(STALE_MARKER));
  check("malformed is never fresh", !hasFreshNoPhotoMarker(MALFORMED_MARKER));

  await db.delete(contacts).where(eq(contacts.userId, USER));

  if (failures > 0) {
    console.error(`\n${failures} check(s) failed.`);
    process.exit(1);
  }
  console.log("\nAll avatar SQL parity checks passed.");
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
