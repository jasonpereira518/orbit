/**
 * Recipient → contact resolution: primary email, identity emails, case, and ownership.
 * Run: npx tsx scripts/smoke-email-contacts.ts
 */
import "./smoke/_env";
import { run } from "./smoke/_env";

import { getDb } from "../src/db";
import * as schema from "../src/db/schema";
import { resolveRecipientContacts } from "../src/lib/email/contacts";
import { purgeUserData } from "../src/lib/user-data";

const USER = "smoke-email-contacts-user";
const OTHER = "smoke-email-contacts-other";

function check(label: string, ok: boolean, detail?: string) {
  if (!ok) throw new Error(`${label} failed${detail ? `: ${detail}` : ""}`);
  console.log(`  ok  ${label}`);
}

async function main() {
  const db = await getDb();
  for (const u of [USER, OTHER]) await purgeUserData(u, { keepSettings: false }).catch(() => {});
  try {
    const [maya] = await db.insert(schema.contacts).values({ userId: USER, fullName: "Maya", email: "Maya@Work.org" }).returning();
    const [sam] = await db.insert(schema.contacts).values({ userId: USER, fullName: "Sam" }).returning();
    await db.insert(schema.contactIdentities).values({ userId: USER, contactId: sam!.id, kind: "email", value: "sam@home.org" });
    const [foreign] = await db.insert(schema.contacts).values({ userId: OTHER, fullName: "X", email: "x@else.org" }).returning();

    const ids = await resolveRecipientContacts(USER, ["maya@work.org", "SAM@home.org", "nobody@x.org", "x@else.org"]);
    check("primary email matches case-insensitively", ids.includes(maya!.id));
    check("identity email matches", ids.includes(sam!.id));
    check("another user's contact never matches", !ids.includes(foreign!.id));
    check("order follows the recipients", ids[0] === maya!.id && ids[1] === sam!.id, JSON.stringify(ids));
    check("empty input → empty", (await resolveRecipientContacts(USER, [])).length === 0);
  } finally {
    for (const u of [USER, OTHER]) await purgeUserData(u, { keepSettings: false }).catch(() => {});
  }
  console.log("\nAll email-contact checks passed.");
}

run(main);
