/**
 * Shared LinkedIn photo cache: upsert semantics (blocked rows are immutable, a negative
 * result never replaces a photo unless refreshing) and freshness windows.
 *
 * Run: npx tsx scripts/smoke-shared-avatars.ts
 */
import "./smoke/_env";
import { run } from "./smoke/_env";
import { eq, like } from "drizzle-orm";
import { getDb } from "../src/db";
import { linkedinAvatars } from "../src/db/schema";
import { getSharedAvatar, isSharedFresh, upsertSharedAvatar } from "../src/lib/shared-avatars";

let failures = 0;
function check(label: string, ok: boolean, detail?: string) {
  if (ok) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.error(`  FAIL ${label}${detail ? `\n       ${detail}` : ""}`);
  }
}

const P = "smoke-shared-avatars-";
const IMG = "https://media.licdn.com/dms/image/x";

run(async () => {
  const db = await getDb();
  const cleanup = () => db.delete(linkedinAvatars).where(like(linkedinAvatars.slug, `${P}%`));
  await cleanup();

  console.log("Upsert semantics...");
  check("no row reads as null", (await getSharedAvatar(`${P}a`)) === null);
  check("insert negative", (await upsertSharedAvatar({ slug: `${P}a`, imageUrl: null, source: "unavatar" })) === true);
  check("negative -> positive replaces", (await upsertSharedAvatar({ slug: `${P}a`, imageUrl: IMG, source: "extension" })) === true);
  let row = await getSharedAvatar(`${P}a`);
  check("positive stored with its source", row?.imageUrl === IMG && row.source === "extension");
  check("negative does not replace a photo", (await upsertSharedAvatar({ slug: `${P}a`, imageUrl: null, source: "unavatar" })) === false);
  check("photo survived", (await getSharedAvatar(`${P}a`))?.imageUrl === IMG);
  check("negative with refresh replaces", (await upsertSharedAvatar({ slug: `${P}a`, imageUrl: null, source: "unavatar", refresh: true })) === true);
  check("refresh cleared the photo", (await getSharedAvatar(`${P}a`))?.imageUrl === null);

  await upsertSharedAvatar({ slug: `${P}b`, imageUrl: IMG, source: "microlink" });
  await db.update(linkedinAvatars).set({ blockedAt: new Date(), blockedBy: "admin" }).where(eq(linkedinAvatars.slug, `${P}b`));
  check("blocked row refuses a positive", (await upsertSharedAvatar({ slug: `${P}b`, imageUrl: "https://x/y.jpg", source: "extension" })) === false);
  check("blocked row refuses a refresh", (await upsertSharedAvatar({ slug: `${P}b`, imageUrl: null, source: "unavatar", refresh: true })) === false);
  row = await getSharedAvatar(`${P}b`);
  check("a non-https image is refused", (await upsertSharedAvatar({ slug: `${P}c`, imageUrl: "data:image/jpeg;base64,AA", source: "unavatar" })) === false && (await getSharedAvatar(`${P}c`)) === null);
  check("so is plain http", (await upsertSharedAvatar({ slug: `${P}c`, imageUrl: "http://x/y.jpg", source: "unavatar" })) === false);
  check("blocked row untouched", row?.imageUrl === IMG && row.source === "microlink" && row.blockedBy === "admin");

  console.log("\nFreshness...");
  const now = new Date("2026-10-13T00:00:00Z");
  const ago = (d: number) => new Date(now.getTime() - d * 86_400_000);
  const r = (imageUrl: string | null, days: number, blocked = false) =>
    ({ imageUrl, resolvedAt: ago(days), blockedAt: blocked ? ago(1) : null });
  check("negative fresh at 29d", isSharedFresh(r(null, 29), now));
  check("negative stale at 31d", !isSharedFresh(r(null, 31), now));
  check("positive fresh at 179d", isSharedFresh(r(IMG, 179), now));
  check("positive stale at 181d", !isSharedFresh(r(IMG, 181), now));
  check("blocked is always fresh", isSharedFresh(r(null, 999, true), now));

  await cleanup();
  if (failures > 0) {
    console.error(`\n${failures} check(s) failed.`);
    process.exit(1);
  }
  console.log("\nAll shared-avatar checks passed.");
});
