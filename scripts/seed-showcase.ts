/**
 * Showcase seed — fills one account with the demo workspace built to demo Orbit end to end.
 *
 * The data and the writer live in `src/lib/demo-data/`, shared with the automatic seed that
 * every localhost dev server runs for empty accounts (`ensureLocalDemoData`). This script is
 * for the cases that one does not cover: a real account on a deployed database, or
 * replacing an account's data with a fresh copy.
 *
 * SAFETY
 *  - Does nothing without an explicit `--user <id>`. There is no default.
 *  - Refuses to touch an account that already has contacts unless `--reset` is passed,
 *    and `--reset` DELETES that user's contacts, tags, reminders, outreach, events, chat,
 *    recruiter links, imports and goals first.
 *  - When DATABASE_URL is set (i.e. a shared/remote database) it additionally requires
 *    `--confirm`, so a mistyped id cannot quietly wipe a real account.
 *  - Stop this worktree's dev server first when running against local PGlite: it takes one
 *    writer, and a second one corrupts the store.
 *
 * Usage:
 *   npx tsx scripts/seed-showcase.ts --user demo-user --reset
 *   npx tsx scripts/seed-showcase.ts --user user_xxx --reset --confirm
 */
import { config } from "dotenv";
config({ path: ".env.local" });
config();

import { eq } from "drizzle-orm";
import { getDb } from "../src/db";
import {
  aiSuggestions,
  chatThreads,
  companies,
  contacts,
  events,
  imports,
  outreachCampaigns,
  recruiterMessages,
  reminderLists,
  reminders,
  suggestedReminders,
  tags,
  userGoals,
  userRecruiterLinks,
} from "../src/db/schema";
import { seedDemoWorkspace } from "../src/lib/demo-data/seed";

const args = process.argv.slice(2);
function flag(name: string) {
  return args.includes(`--${name}`);
}
function value(name: string) {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
}

const USER = value("user");
const RESET = flag("reset");
const REMOTE = Boolean(process.env.DATABASE_URL?.trim());

if (!USER || USER.startsWith("--")) {
  console.error(
    "Missing --user <id>.\n" +
      "  local demo mode: --user demo-user\n" +
      "  a real account:  --user <clerk user id, from the Clerk dashboard>"
  );
  process.exit(1);
}
if (REMOTE && !flag("confirm")) {
  console.error(
    `DATABASE_URL is set, so this would write to the shared database as "${USER}".\n` +
      "Re-run with --confirm once you have checked the id."
  );
  process.exit(1);
}

async function main() {
  const userId = USER!;
  const db = await getDb();

  const existing = await db.query.contacts.findFirst({
    where: eq(contacts.userId, userId),
    columns: { id: true },
  });
  if (existing && !RESET) {
    console.error(
      `"${userId}" already has contacts. Re-run with --reset to replace them, ` +
        "or pick an empty account."
    );
    process.exit(1);
  }

  if (RESET) {
    // Contacts cascade to interactions, action items, briefs, profiles, experiences,
    // identities, contact_tags and embeddings. `ai_suggestions` and `suggested_reminders`
    // do NOT: they reference contacts through a jsonb id array or set-null, so without
    // this the dashboard keeps showing the previous fixture's queue against contacts that
    // no longer exist. Campaigns, events and chat threads cascade to their children.
    await db.delete(aiSuggestions).where(eq(aiSuggestions.userId, userId));
    await db.delete(suggestedReminders).where(eq(suggestedReminders.userId, userId));
    await db.delete(reminders).where(eq(reminders.userId, userId));
    await db.delete(reminderLists).where(eq(reminderLists.userId, userId));
    await db.delete(outreachCampaigns).where(eq(outreachCampaigns.userId, userId));
    await db.delete(events).where(eq(events.userId, userId));
    await db.delete(chatThreads).where(eq(chatThreads.userId, userId));
    await db.delete(recruiterMessages).where(eq(recruiterMessages.userId, userId));
    await db.delete(userRecruiterLinks).where(eq(userRecruiterLinks.userId, userId));
    await db.delete(imports).where(eq(imports.userId, userId));
    await db.delete(userGoals).where(eq(userGoals.userId, userId));
    await db.delete(contacts).where(eq(contacts.userId, userId));
    await db.delete(companies).where(eq(companies.userId, userId));
    await db.delete(tags).where(eq(tags.userId, userId));
  }

  const summary = await seedDemoWorkspace(userId);
  console.log(`Seeded the demo workspace for "${userId}"`);
  for (const [name, count] of Object.entries(summary)) {
    console.log(`  ${name.padEnd(18)} ${count}`);
  }
  console.log("\nNext: open /dashboard once so the outreach queue builds, then /graph.");

  // PGlite keeps the event loop alive — exit explicitly.
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
