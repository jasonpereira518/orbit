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
 *   3. Seeds the account's persona (`PERSONA_BY_EMAIL`; the founder workspace by default).
 *   4. Comps the Orbit plan, lets the account past stealth, and marks first-run done.
 *   5. Gillings only: writes the owner's own profile (the purge wipes it), then stores every
 *      contact photo now rather than five per page view, so the demo opens fully pictured.
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
 *   npx tsx scripts/seed-demo-workspace.ts --email jamestjahjadi1@gmail.com --reset --confirm
 */
import { config } from "dotenv";
config({ path: ".env.local" });
config();

import { and, eq } from "drizzle-orm";
import { getDb } from "../src/db";
import { contacts, userSettings } from "../src/db/schema";
import { findAvatarBackfillCandidates } from "../src/lib/avatar-backfill";
import { downloadAndPersistAvatar } from "../src/lib/contact-avatar";
import { GILLINGS_OWNER } from "../src/lib/demo-data/gillings";
import { seedDemoWorkspace, type DemoPersona } from "../src/lib/demo-data/seed";
import { addTargetCompany } from "../src/lib/events/target-companies";
import { DEMO_WORKSPACE_EMAILS, isDemoWorkspaceEmail } from "../src/lib/demo-workspace";
import { markStealthCleared } from "../src/lib/site-access";
import { purgeUserData } from "../src/lib/user-data";
import { findUsersByEmail } from "../src/lib/user-settings";

/** Which workspace each demo account gets; anything unlisted is the founder workspace. */
const PERSONA_BY_EMAIL: Record<string, DemoPersona> = {
  "jamestjahjadi1@gmail.com": "gillings",
};

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

  const persona = PERSONA_BY_EMAIL[EMAIL!] ?? "founder";
  const summary = await seedDemoWorkspace(userId, { persona, extended: true });

  // Written directly rather than through `setCompedPlan`, which queues the plan-upgrade
  // celebration: that would play the moment the recording opens the app.
  await db
    .update(userSettings)
    .set({ compedPlan: "orbit", compedNote: "Demo workspace", compedAt: new Date(), updatedAt: new Date() })
    .where(eq(userSettings.userId, userId));
  await markStealthCleared(userId);

  if (persona === "gillings") {
    await db
      .update(userSettings)
      .set({
        senderBio: GILLINGS_OWNER.senderBio,
        schools: GILLINGS_OWNER.schools,
        careerProfile: { ...GILLINGS_OWNER.careerProfile, importedAt: new Date().toISOString() },
        updatedAt: new Date(),
      })
      .where(eq(userSettings.userId, userId));
    for (const name of GILLINGS_OWNER.targetCompanies) await addTargetCompany(userId, name, 1);
    summary.photos = await storeAllPhotos(userId);
  }

  console.log(`Seeded the demo workspace for ${EMAIL} (${userId})`);
  for (const [name, count] of Object.entries(summary)) {
    console.log(`  ${name.padEnd(18)} ${count}`);
  }
  console.log("\nNext: open /dashboard once so the suggestion queue builds, then /graph.");

  // PGlite and the Neon driver both keep the event loop alive — exit explicitly.
  process.exit(0);
}

/**
 * Copies every remote portrait into app storage now. The app does this five contacts per page
 * view; a pitch should not open on a wall of initials. A photo that still fails after a few
 * retries is skipped and left for the ordinary backfill.
 */
async function storeAllPhotos(userId: string): Promise<number> {
  const db = await getDb();
  const skipIds: string[] = [];
  let stored = 0;
  for (;;) {
    const batch = (await findAvatarBackfillCandidates(db, userId, { limit: 25, skipIds })).filter((c) => c.remoteUrl);
    if (batch.length === 0) return stored;
    for (const c of batch) {
      // Wikimedia rate-limits a burst of downloads, so a miss waits and tries again.
      let url: string | null = null;
      for (let attempt = 0; attempt < 4 && !url; attempt++) {
        if (attempt) await new Promise((r) => setTimeout(r, 1500 * attempt));
        url = await downloadAndPersistAvatar(c.id, c.remoteUrl!).catch(() => null);
      }
      if (!url) {
        skipIds.push(c.id);
        console.warn(`  photo not stored for contact ${c.id}: ${c.remoteUrl}`);
        continue;
      }
      // `updatedAt` left alone, as the app's own backfill does: a photo is not an edit.
      await db.update(contacts).set({ profileImageUrl: url }).where(and(eq(contacts.id, c.id), eq(contacts.userId, userId)));
      stored += 1;
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
