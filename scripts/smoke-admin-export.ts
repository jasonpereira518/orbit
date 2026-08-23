/**
 * Guards the one path that takes data *out* of the console.
 *
 * The reveal grant is a licence to look at one account for fifteen minutes. Export is
 * forever and leaves the building, so the two must never meet: the assertion that matters
 * here is that a live grant changes nothing about what an export contains.
 *
 * Run: npx tsx scripts/smoke-admin-export.ts
 */
import { config } from "dotenv";
config({ path: ".env.local" });
config();

import { readFileSync } from "node:fs";
import { inArray, like } from "drizzle-orm";
import Papa from "papaparse";
import { getDb } from "../src/db";
import {
  adminAuditLog,
  adminRevealGrants,
  contacts,
  interactions,
  userSettings,
} from "../src/db/schema";
import { assertNoForbiddenValues } from "../src/lib/admin-redaction";
import { createRevealGrant } from "../src/lib/admin-reveal";
import { loadAdminRosterAll } from "../src/lib/admin-roster";
import { ensureUserSettings } from "../src/lib/user-settings";

const PREFIX = "smoke-export-";
const ADMIN = `${PREFIX}operator`;
const USER = `${PREFIX}account`;

const SECRET = {
  name: "Hieronymus Blackwood",
  email: "hieronymus.blackwood@example-secret.test",
  phone: "+1-555-0199-SECRET",
  notes: "SECRET-EXPORT-NOTE about the acquisition",
  rawNotes: "SECRET-EXPORT-RAWNOTES from the coffee chat",
};
const FORBIDDEN = Object.values(SECRET);

function check(label: string, condition: boolean, detail?: string) {
  if (!condition) throw new Error(`${label} failed${detail ? `: ${detail}` : ""}`);
  console.log(`  ok  ${label}`);
}

async function cleanup() {
  const db = await getDb();
  await db.delete(interactions).where(inArray(interactions.userId, [USER]));
  await db.delete(contacts).where(inArray(contacts.userId, [USER]));
  await db.delete(adminRevealGrants).where(like(adminRevealGrants.targetUserId, `${PREFIX}%`));
  await db.delete(adminAuditLog).where(like(adminAuditLog.targetUserId, `${PREFIX}%`));
  await db.delete(userSettings).where(inArray(userSettings.userId, [USER, ADMIN]));
}

async function main() {
  console.log("Admin export");
  process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY ||= "pk_test_fake";
  process.env.ADMIN_USER_IDS = ADMIN;

  await cleanup();
  const db = await getDb();
  await ensureUserSettings(USER);
  await db
    .update(userSettings)
    .set({ email: `${PREFIX}account@example.test` })
    .where(inArray(userSettings.userId, [USER]));

  const [contact] = await db
    .insert(contacts)
    .values({
      userId: USER,
      fullName: SECRET.name,
      email: SECRET.email,
      phone: SECRET.phone,
      notes: SECRET.notes,
      company: "Blackwood & Co",
    })
    .returning();
  await db.insert(interactions).values({
    userId: USER,
    contactId: contact.id,
    interactionType: "coffee",
    interactionDate: new Date(),
    rawNotes: SECRET.rawNotes,
  });

  /* ------------------------------------------------- the roster carries no contact data */

  const roster = await loadAdminRosterAll({ q: PREFIX });
  check("the export query finds the seeded account", roster.length === 1);
  assertNoForbiddenValues(roster, FORBIDDEN);
  console.log("  ok  roster export contains no seeded contact value");

  const keys = Object.keys(roster[0]);
  check(
    "the roster row exposes counts, not contacts",
    keys.includes("counts") && !keys.includes("contacts"),
    keys.join(",")
  );

  /* --------------------------------------- a live grant does not change what is exported */

  const before = JSON.stringify(await loadAdminRosterAll({ q: PREFIX }));
  await createRevealGrant({
    adminUserId: ADMIN,
    targetUserId: USER,
    reason: "a grant that must not reach the export path",
  });
  const after = JSON.stringify(await loadAdminRosterAll({ q: PREFIX }));

  check("a live reveal grant changes nothing about the export", before === after);
  assertNoForbiddenValues(JSON.parse(after), FORBIDDEN);
  console.log("  ok  export stays grant-blind while a grant is live");

  /* ------------------------------------------------------------- CSV round-trips cleanly */

  const csv = Papa.unparse(
    roster.map((r) => ({
      user_id: r.userId,
      email: r.email ?? "",
      plan: r.plan,
      contacts: r.counts.contacts,
    }))
  );
  const parsed = Papa.parse(csv, { header: true, skipEmptyLines: true });
  check("CSV round-trips to the same row count", parsed.data.length === roster.length);

  const header = csv.split("\n")[0];
  for (const banned of ["phone", "notes", "full_name", "key_facts", "raw_notes"]) {
    if (header.includes(banned)) {
      throw new Error(`the CSV header exposes a contact column: ${banned}`);
    }
  }
  console.log("  ok  no contact-PII column appears in the CSV header");

  /* ------------------------------------- the handler gates itself, and 404s rather than 403 */

  const source = readFileSync("src/app/api/admin/export/route.ts", "utf8");
  check(
    "the route asserts the admin gate itself",
    source.includes("requireAdminUserId()"),
    "route handlers do not run the (admin) layout"
  );
  check(
    "an unauthorised caller gets 404, never 403",
    source.includes("status: 404") && !source.includes("status: 403")
  );
  check(
    "the response is marked no-store",
    source.includes("private, no-store")
  );
  // The precise assertion: the handler never imports a table that holds third-party data,
  // so it cannot query one. A `contacts:` key in the output is a count column, not a read.
  const schemaImport = source.match(/from\s+["']@\/db\/schema["']/);
  check(
    "the export imports no table from the schema at all",
    schemaImport === null,
    "it builds every dataset from admin lib functions, which are already redacted"
  );
  for (const table of ["contacts", "interactions", "chatMessages", "chat_messages"]) {
    if (new RegExp(`\\b${table}\\.`).test(source)) {
      throw new Error(`the export route references the ${table} table`);
    }
  }
  console.log("  ok  the export route references no third-party data table");

  console.log("Done.");
}

main()
  .then(async () => {
    await cleanup();
    process.exit(0);
  })
  .catch(async (e) => {
    console.error(e);
    await cleanup().catch(() => {});
    process.exit(1);
  });
