/**
 * Demo workspace seed — fills the demo-recording account with the extended demo workspace.
 *
 * The account is named by email, and only an email in `DEMO_WORKSPACE_EMAILS`
 * (`src/lib/demo-workspace.ts`) is accepted, so this cannot wipe anyone else. Run it against
 * the database the demo is recorded from — production, usually — and re-run it shortly before
 * recording: every date in the workspace is relative to when it was seeded.
 *
 * What it does, in order:
 *   1. Finds the account by its Clerk-verified email (`user_settings.email`).
 *   2. With `--reset`, deletes the account's data through `purgeUserData` — the same
 *      category registry "Delete my data" uses — keeping settings such as a saved AI key.
 *   3. Seeds `seedDemoWorkspace(userId, { extended: true })`.
 *   4. Comps the Orbit plan, lets the account past stealth, and marks first-run done.
 *
 * SAFETY
 *  - Refuses any email not in the demo-workspace list.
 *  - Refuses an account that already has contacts unless `--reset` is passed.
 *  - When DATABASE_URL is set it also requires `--confirm`.
 *  - Stop this worktree's dev server first when running against local PGlite: it takes one
 *    writer, and a second one corrupts the store.
 *
 * Usage:
 *   npx tsx scripts/seed-demo-workspace.ts --email jasonnp510@gmail.com --reset --confirm
 */
import { config } from "dotenv";
config({ path: ".env.local" });
config();

import { eq } from "drizzle-orm";
import { getDb } from "../src/db";
import { contacts, userSettings } from "../src/db/schema";
import { seedDemoWorkspace } from "../src/lib/demo-data/seed";
import { DEMO_WORKSPACE_EMAILS, isDemoWorkspaceEmail } from "../src/lib/demo-workspace";
import { markStealthCleared } from "../src/lib/site-access";
import { purgeUserData } from "../src/lib/user-data";
import { findUsersByEmail } from "../src/lib/user-settings";

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(`--${name}`);
function value(name: string) {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
}

const EMAIL = value("email")?.trim().toLowerCase();
const RESET = flag("reset");
const REMOTE = Boolean(process.env.DATABASE_URL?.trim());

if (!EMAIL || EMAIL.startsWith("--")) {
  console.error(`Missing --email. Demo-workspace accounts: ${DEMO_WORKSPACE_EMAILS.join(", ")}`);
  process.exit(1);
}
if (!isDemoWorkspaceEmail(EMAIL)) {
  console.error(
    `${EMAIL} is not a demo-workspace account, so this refuses to touch it.\n` +
      `Demo-workspace accounts: ${DEMO_WORKSPACE_EMAILS.join(", ")} (src/lib/demo-workspace.ts).`
  );
  process.exit(1);
}
if (REMOTE && !flag("confirm")) {
  console.error(
    `DATABASE_URL is set, so this writes to that database as ${EMAIL}.\n` +
      "Re-run with --confirm once you have checked which database it is."
  );
  process.exit(1);
}

async function main() {
  const matches = await findUsersByEmail(EMAIL!);
  if (matches.length === 0) {
    console.error(
      `No account with the email ${EMAIL} in this database.\n` +
        "Sign up with it on the site first (while stealth is on, invite it from /admin/access), then re-run."
    );
    process.exit(1);
  }
  if (matches.length > 1) {
    console.error(
      `${matches.length} accounts share ${EMAIL}: ${matches.map((m) => m.userId).join(", ")}.\n` +
        "Refusing to guess which one to seed."
    );
    process.exit(1);
  }
  const userId = matches[0].userId;
  const db = await getDb();

  const existing = await db.query.contacts.findFirst({
    where: eq(contacts.userId, userId),
    columns: { id: true },
  });
  if (existing && !RESET) {
    console.error(`${EMAIL} (${userId}) already has contacts. Re-run with --reset to replace them.`);
    process.exit(1);
  }

  if (RESET) {
    const outcome = await purgeUserData(userId, { keepSettings: true });
    console.log(`Cleared ${EMAIL}'s data (${outcome.completed.length} categories).`);
  }

  const summary = await seedDemoWorkspace(userId, { extended: true });

  // Written directly rather than through `setCompedPlan`, which queues the plan-upgrade
  // celebration: that would play the moment the recording opens the app.
  await db
    .update(userSettings)
    .set({ compedPlan: "orbit", compedNote: "Demo workspace", compedAt: new Date(), updatedAt: new Date() })
    .where(eq(userSettings.userId, userId));
  await markStealthCleared(userId);

  console.log(`Seeded the demo workspace for ${EMAIL} (${userId})`);
  for (const [name, count] of Object.entries(summary)) {
    console.log(`  ${name.padEnd(18)} ${count}`);
  }
  console.log("\nNext: open /dashboard once so the suggestion queue builds, then /graph.");

  // PGlite and the Neon driver both keep the event loop alive — exit explicitly.
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
