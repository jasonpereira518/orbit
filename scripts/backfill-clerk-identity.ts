/**
 * Fills in `user_settings.first_name` / `last_name` / `profile_image_url` for accounts that
 * existed before the Clerk identity mirror.
 *
 * WHY A ONE-SHOT SCRIPT. The webhook (`src/app/api/webhooks/clerk/route.ts`) keeps these
 * columns current from `user.created` / `user.updated` onward, at no cost — the payload
 * already carries them. But it only fires when something changes, so every existing account
 * would sit nameless in the admin roster until its owner happened to edit their Clerk
 * profile. This is the only place in the codebase that calls the Clerk Backend API, and it
 * is deliberately not on any render path: the console reads from Postgres alone.
 *
 * Run once after deploying the migration:
 *   npx tsx scripts/backfill-clerk-identity.ts
 *
 * Needs CLERK_SECRET_KEY. Safe to re-run — `setUserIdentity` writes only on change, so a
 * second pass over unchanged accounts issues no UPDATEs at all.
 *
 * Only touches accounts Orbit already knows about. Clerk may hold users who never
 * completed sign-up and so have no `user_settings` row; creating rows for them here would
 * inflate every count on the Overview with people who have never used the product.
 */
import { config } from "dotenv";
config({ path: ".env.local" });
config();

import { and, isNull } from "drizzle-orm";
import { getDb } from "../src/db";
import { userSettings } from "../src/db/schema";
import { setUserIdentity } from "../src/lib/user-settings";

const PAGE = 100;

async function main() {
  if (!process.env.CLERK_SECRET_KEY?.trim()) {
    throw new Error(
      "CLERK_SECRET_KEY is not set. This script reads identity from Clerk's Backend API."
    );
  }

  const db = await getDb();
  const known = await db.select({ userId: userSettings.userId }).from(userSettings);
  const knownIds = new Set(known.map((r) => r.userId));
  console.log(`${knownIds.size} account(s) in user_settings.`);

  if (knownIds.size === 0) {
    console.log("Nothing to backfill.");
    return;
  }

  // Imported lazily so the env check above runs first, and so the module is not pulled in
  // at all on the empty path.
  const { clerkClient } = await import("@clerk/nextjs/server");
  const clerk = await clerkClient();

  let offset = 0;
  let seen = 0;
  let updated = 0;
  let skipped = 0;

  for (;;) {
    const { data } = await clerk.users.getUserList({ limit: PAGE, offset });
    if (data.length === 0) break;

    for (const user of data) {
      seen += 1;
      if (!knownIds.has(user.id)) {
        skipped += 1;
        continue;
      }

      await setUserIdentity(user.id, {
        firstName: user.firstName,
        lastName: user.lastName,
        imageUrl: user.imageUrl,
      });
      updated += 1;
    }

    offset += data.length;
    if (data.length < PAGE) break;
  }

  console.log(`Scanned ${seen} Clerk user(s).`);
  console.log(`  matched and mirrored: ${updated}`);
  console.log(`  no user_settings row (never finished sign-up): ${skipped}`);

  // Report what is still blank, so "the backfill ran" and "the roster shows names" stay two
  // separately verifiable claims. A Clerk account with no name set is legitimate, and the
  // roster falls back to the email — but you should find that out here, not from a screen
  // full of email addresses.
  const nameless = await db
    .select({ userId: userSettings.userId, email: userSettings.email })
    .from(userSettings)
    .where(
      and(isNull(userSettings.firstName), isNull(userSettings.lastName))
    );
  if (nameless.length > 0) {
    console.log(
      `\n${nameless.length} account(s) still have no name — Clerk has none set for them:`
    );
    for (const r of nameless) console.log(`  ${r.userId}  ${r.email ?? "(no email)"}`);
  }

  console.log("\nDone.");
}

main()
  .then(() => {
    // Clerk's SDK pulls in `next/server`, which alone keeps the Node event loop alive.
    // Every script in this directory exits explicitly for the same reason.
    process.exit(0);
  })
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
