/**
 * Avatar blobs follow their contacts out: a merge loser's orphaned photo and every photo in
 * a contacts purge. Run: npx tsx scripts/smoke-avatar-cleanup.ts
 */
import "./smoke/_env";
import { run } from "./smoke/_env";

import { eq } from "drizzle-orm";
import { getDb } from "../src/db";
import * as schema from "../src/db/schema";
import { setAvatarBlobClientForTests } from "../src/lib/avatar-blob";
import { mergeContacts, unmergeContacts } from "../src/lib/contact-merge";
import { purgeUserData } from "../src/lib/user-data";

const USER = "smoke-avatar-cleanup-user";
const BLOB = (n: string) => `https://abc.public.blob.vercel-storage.com/avatars/${n}.jpg`;

function check(label: string, ok: boolean, detail?: string) {
  if (!ok) throw new Error(`${label} failed${detail ? `: ${detail}` : ""}`);
  console.log(`  ok  ${label}`);
}

async function contact(fullName: string, profileImageUrl: string | null) {
  const db = await getDb();
  const [row] = await db.insert(schema.contacts).values({ userId: USER, fullName, profileImageUrl }).returning();
  return row.id;
}

async function main() {
  const db = await getDb();
  const deleted: string[] = [];
  setAvatarBlobClientForTests({ put: async () => ({ url: "" }), del: async (urls) => void deleted.push(...urls) });
  try {
    console.log("Merge");
    const winner = await contact("Ada Lovelace", BLOB("winner"));
    const loser = await contact("A. Lovelace", BLOB("loser"));
    const { mergeId } = await mergeContacts(USER, winner, loser, { deferInvalidation: true });
    check("the loser's orphaned photo is deleted", deleted.includes(BLOB("loser")) && !deleted.includes(BLOB("winner")), JSON.stringify(deleted));
    const [archive] = await db.select().from(schema.contactMerges).where(eq(schema.contactMerges.id, mergeId));
    check("the snapshot no longer points at the deleted object", (archive.loserSnapshot as Record<string, unknown>).profile_image_url === null);
    await unmergeContacts(USER, mergeId);
    const [restored] = await db.select().from(schema.contacts).where(eq(schema.contacts.id, loser));
    check("an unmerge restores the contact with no dead photo URL", restored?.profileImageUrl === null, String(restored?.profileImageUrl));

    deleted.length = 0;
    const bare = await contact("Grace Hopper", null);
    const donor = await contact("G. Hopper", BLOB("donor"));
    await mergeContacts(USER, bare, donor, { deferInvalidation: true });
    const [adopted] = await db.select().from(schema.contacts).where(eq(schema.contacts.id, bare));
    check("a winner with no photo adopts the loser's, and nothing is deleted", adopted?.profileImageUrl === BLOB("donor") && deleted.length === 0);

    console.log("\nPurge");
    deleted.length = 0;
    await purgeUserData(USER, { only: ["contacts"] });
    check("the contacts step deletes every photo it references", deleted.includes(BLOB("winner")) && deleted.includes(BLOB("donor")), JSON.stringify(deleted));
  } finally {
    setAvatarBlobClientForTests(null);
    await purgeUserData(USER, { keepSettings: false }).catch(() => {});
  }
  console.log("\nAll avatar-cleanup checks passed.");
}

run(main);
