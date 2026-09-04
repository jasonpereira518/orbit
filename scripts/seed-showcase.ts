/**
 * Showcase seed — loads the hand-written demo network into an account.
 *
 * The dataset and the insert logic both live in `src/lib/fixtures/showcase.ts`, because the
 * testing console's reseed button needs exactly the same thing and a second copy would
 * drift. This file is the CLI around it: argument parsing and the safety rails below.
 *
 * SAFETY
 *  - Does nothing without an explicit `--user <id>`. There is no default.
 *  - Refuses to touch an account that already has contacts unless `--reset` is passed.
 *    `seedShowcase` always replaces the network, so `--reset` is the acknowledgement
 *    rather than a mode.
 *  - When DATABASE_URL is set (i.e. a shared/remote database) it additionally requires
 *    `--confirm`, so a mistyped id cannot quietly wipe a real account.
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
import { contacts } from "../src/db/schema";
import { seedShowcase } from "../src/lib/fixtures/showcase";

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
    `DATABASE_URL is set, so this would write to the shared database.\n` +
      `Re-run with --confirm if "${USER}" is really the account you mean.`
  );
  process.exit(1);
}

async function main() {
  const db = await getDb();

  const existing = await db.query.contacts.findFirst({
    where: eq(contacts.userId, USER!),
    columns: { id: true },
  });
  if (existing && !RESET) {
    console.error(
      `"${USER}" already has contacts. Re-run with --reset to replace them, ` +
        "or pick an empty account."
    );
    process.exit(1);
  }

  const result = await seedShowcase(USER!);

  console.log(`Seeded ${result.contacts} contacts for "${USER}"`);
  console.log(`  interactions ${result.interactions}`);
  console.log(`  reminders    ${result.reminders}`);
  console.log(`  tags         ${result.tags} (${result.tagLinks} links)`);
  console.log(`  companies    ${result.companies}`);
  console.log(
    `  follow-ups   ${result.overdueFollowUps} overdue · ${result.upcomingFollowUps} upcoming`
  );
  console.log(
    "\nNext: open /dashboard once so the outreach queue builds, then /graph."
  );

  // PGlite keeps the event loop alive — exit explicitly.
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
