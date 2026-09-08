/**
 * Reports contacts that look like the account owner themselves.
 *
 * Capture had no self-filter until `src/lib/self-identity.ts` landed, so a pasted calendar
 * invite or forwarded email seeded the user as an attendee and created a contact for them.
 * The filter stops new ones; this finds the rows already written.
 *
 * READ-ONLY, DELIBERATELY. It prints and exits — it never deletes. Two reasons: `isSelf`
 * can be wrong (a mononym owner, a shared family address), and a contact row may have
 * accumulated real interactions and reminders since. Deciding what to do with each match is
 * a judgement call, so the script hands you the list and the profile URLs and stops there.
 *
 * Run:
 *   npx tsx scripts/find-self-contacts.ts            # every user
 *   npx tsx scripts/find-self-contacts.ts <userId>   # one user
 *
 * NOTE ON WHICH DATABASE THIS HITS. `.env.local` sets DATABASE_URL, so this reads the
 * shared remote database, not a local PGlite. That is what you want for a real audit — but
 * it is worth knowing before you run it, because "local script" reads as safe and several
 * scripts in this repo have surprised people on exactly this point.
 */
import { config } from "dotenv";
config({ path: ".env.local" });
config();

import { eq } from "drizzle-orm";
import { getDb } from "../src/db";
import { contacts, userSettings } from "../src/db/schema";
import { getSelfIdentity, isSelf } from "../src/lib/self-identity";

async function main() {
  const only = process.argv[2] || null;
  const db = await getDb();

  const owners = only
    ? await db.query.userSettings.findMany({
        where: eq(userSettings.userId, only),
        columns: { userId: true, email: true },
      })
    : await db.query.userSettings.findMany({ columns: { userId: true, email: true } });

  if (!owners.length) {
    console.log(only ? `No user_settings row for ${only}` : "No accounts found.");
    return;
  }

  let total = 0;

  for (const owner of owners) {
    const self = await getSelfIdentity(owner.userId);
    // An identity with nothing in it matches nobody, so skip rather than scan for free.
    if (!self.emails.size && !self.linkedinSlug && !self.name) continue;

    const rows = await db.query.contacts.findMany({
      where: eq(contacts.userId, owner.userId),
      columns: {
        id: true,
        fullName: true,
        email: true,
        linkedinUrl: true,
        company: true,
        source: true,
        createdAt: true,
      },
    });

    const matches = rows.filter((c) =>
      isSelf({ name: c.fullName, email: c.email, linkedinUrl: c.linkedinUrl }, self)
    );
    if (!matches.length) continue;

    total += matches.length;
    console.log(`\n${owner.userId}${owner.email ? `  (${owner.email})` : ""}`);
    console.log(`  identity: name="${self.name}" emails=[${[...self.emails].join(", ")}] linkedin="${self.linkedinSlug}"`);
    for (const c of matches) {
      const why = c.email
        ? `email ${c.email}`
        : c.linkedinUrl
          ? `linkedin ${c.linkedinUrl}`
          : `name "${c.fullName}"`;
      console.log(
        `  - ${c.fullName || "(unnamed)"}${c.company ? ` @ ${c.company}` : ""}` +
          `  [source=${c.source || "?"}]  matched on ${why}`
      );
      console.log(`      /contacts/${c.id}`);
    }
  }

  console.log(
    total
      ? `\n${total} contact${total === 1 ? "" : "s"} look like their account owner. Nothing was changed — review each profile above and delete manually.`
      : "\nNo self-contacts found."
  );
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
