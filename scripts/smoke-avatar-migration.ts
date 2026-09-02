/**
 * Asserts the inline→Blob avatar migration selects exactly the rows holding a data: URL,
 * rewrites them to the uploaded URL, and is idempotent. The uploader is injected, so no
 * Blob store or network is involved.
 *
 * Runs against the local PGlite database. Run: npx tsx scripts/smoke-avatar-migration.ts
 */
import { config } from "dotenv";
config({ path: ".env.local" });
config();
delete process.env.DATABASE_URL;

import { eq } from "drizzle-orm";
import { getDb } from "../src/db";
import { contacts } from "../src/db/schema";
import { migrateInlineAvatars } from "./lib/avatar-migration";

const USER = "smoke-avatar-migration-user";
// A real (tiny) JPEG header so parseImageDataUrl accepts it.
const INLINE = "data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDA==";

function check(label: string, cond: boolean, detail?: string) {
  if (!cond) throw new Error(`${label} FAILED${detail ? `: ${detail}` : ""}`);
  console.log("  ok  " + label);
}

async function main() {
  const db = await getDb();
  await db.delete(contacts).where(eq(contacts.userId, USER));
  await db.insert(contacts).values([
    { userId: USER, fullName: "Inline one", profileImageUrl: INLINE },
    { userId: USER, fullName: "Inline two", profileImageUrl: INLINE },
    { userId: USER, fullName: "Remote", profileImageUrl: "https://media.licdn.com/x.jpg" },
    { userId: USER, fullName: "None", profileImageUrl: null },
  ]);

  const dry = await migrateInlineAvatars({ dryRun: true, upload: async () => "unused" });
  // Other users' inline rows may exist locally, so assert on ours by difference.
  check("dry run counts the inline rows", dry.moved >= 2 && dry.moved === dry.total, JSON.stringify(dry));
  const untouched = await db.query.contacts.findMany({ where: eq(contacts.userId, USER) });
  check("dry run changes nothing", untouched.filter((c) => c.profileImageUrl === INLINE).length === 2);

  const uploads: string[] = [];
  const real = await migrateInlineAvatars({
    dryRun: false,
    upload: async (path) => {
      uploads.push(path);
      return `https://smoke.public.blob.vercel-storage.com/${path}`;
    },
  });
  check("uploads once per inline row", uploads.length === real.moved && real.moved >= 2, JSON.stringify(real));
  const after = await db.query.contacts.findMany({ where: eq(contacts.userId, USER) });
  const byName = new Map(after.map((c) => [c.fullName, c.profileImageUrl]));
  check("inline rows now hold the Blob URL", [...byName.entries()].filter(([, v]) => v?.includes(".public.blob.vercel-storage.com/avatars/")).length === 2);
  check("uploaded at the backfill's stable path", uploads.every((p) => /^avatars\/[0-9a-f-]+\.jpg$/.test(p)), uploads.join(","));
  check("remote row untouched", byName.get("Remote") === "https://media.licdn.com/x.jpg");
  check("empty row untouched", byName.get("None") === null);

  const again = await migrateInlineAvatars({ dryRun: false, upload: async () => { throw new Error("must not upload"); } });
  check("second run finds nothing left", again.moved === 0, JSON.stringify(again));

  await db.delete(contacts).where(eq(contacts.userId, USER));
  console.log("\nAll avatar-migration checks passed.");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
