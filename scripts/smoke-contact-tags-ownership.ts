/**
 * `updateContactForUser` with `tagNames` and a contact id that is not the caller's.
 *
 * The UPDATE itself is user-scoped and matches nothing, but the tag sync ran regardless: it
 * deleted every tag on the other account's contact and attached the caller's tags to it. The
 * `updateContact` server action passes `tagNames` straight from the client, so any signed-in
 * user who knew another account's contact id could do this. The sync now runs only when the
 * update matched the caller's own row.
 *
 * PGlite, no network. Run: npx tsx scripts/smoke-contact-tags-ownership.ts
 */
import "./smoke/_env";

import { eq } from "drizzle-orm";
import { getDb } from "../src/db";
import { contactTags, tags } from "../src/db/schema";
import { updateContactForUser } from "../src/lib/contact-writes";
import { fakeUserId, insertContact, purgeUsers } from "./smoke/factories";

const VICTIM = fakeUserId("tagown_victim");
const ATTACKER = fakeUserId("tagown_attacker");

let failures = 0;
function check(label: string, ok: boolean, detail?: string) {
  if (ok) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.error(`  FAIL ${label}${detail ? `\n       ${detail}` : ""}`);
  }
}

async function main() {
  const db = await getDb();
  await purgeUsers(db, [VICTIM, ATTACKER]);
  const victimContact = await insertContact(db, VICTIM, 1);
  const attackerContact = await insertContact(db, ATTACKER, 2);
  const [vip] = await db.insert(tags).values({ userId: VICTIM, name: "vip" }).returning();
  await db.insert(contactTags).values({ contactId: victimContact.id, tagId: vip.id });

  const tagsOf = async (contactId: string) =>
    (await db.select({ tagId: contactTags.tagId }).from(contactTags).where(eq(contactTags.contactId, contactId))).map((r) => r.tagId);

  const result = await updateContactForUser(ATTACKER, victimContact.id, { tagNames: ["planted"] }, { skipRevalidate: true, skipEmbedding: true });
  check("an update of another account's contact matches nothing", result === undefined || result === null, JSON.stringify(result));
  const after = await tagsOf(victimContact.id);
  check("…and leaves that contact's tags exactly as they were", after.length === 1 && after[0] === vip.id, JSON.stringify(after));
  const planted = await db.query.tags.findFirst({ where: eq(tags.name, "planted") });
  check("…and attaches none of the caller's tags to it", !planted || !(await tagsOf(victimContact.id)).includes(planted.id));

  await updateContactForUser(ATTACKER, attackerContact.id, { tagNames: ["mine"] }, { skipRevalidate: true, skipEmbedding: true });
  const own = await tagsOf(attackerContact.id);
  check("control: the caller's own contact still gets its tags", own.length === 1, JSON.stringify(own));

  await purgeUsers(db, [VICTIM, ATTACKER]);
  if (failures) {
    console.error(`\n${failures} contact-tags-ownership check(s) failed.`);
    process.exit(1);
  }
  console.log("\nAll contact-tags-ownership checks passed.");
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
