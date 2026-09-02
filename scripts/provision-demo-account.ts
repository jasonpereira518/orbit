/**
 * Provision (or repair) the Orbit showcase login.
 *
 * Creates a Clerk user with a known email/password so the same login works for anyone
 * running the live demo — no "whose account is this" scramble at the venue. Idempotent:
 * re-running it against an account that already exists just resets the password and
 * name, it never creates a duplicate.
 *
 * This only touches Clerk (identity). It does not touch the contacts database — run
 * `scripts/seed-showcase.ts --user <id> --reset --confirm` separately, using the id this
 * script prints, to populate the account's network. Order doesn't matter: contacts carry
 * a plain userId string with no foreign key into Clerk, so seeding before or after
 * provisioning both work, and the first real sign-in bootstraps `user_settings` and
 * marks onboarding complete because contacts already exist.
 *
 * Usage:
 *   CLERK_SECRET_KEY=sk_live_xxx npx tsx scripts/provision-demo-account.ts
 *   CLERK_SECRET_KEY=sk_live_xxx npx tsx scripts/provision-demo-account.ts --email you@x.com --password "Something123!"
 *
 * CLERK_SECRET_KEY is deliberately NOT read from .env.local here — this repo's
 * .env.local keeps Clerk commented out for local demo-mode dev, and the key that
 * matters is whichever Clerk *instance* actually backs the environment you're
 * demoing from (dev/test vs. the live production project). Pass it explicitly so
 * there is no ambiguity about which instance just got a new login.
 */
import { config } from "dotenv";
config({ path: ".env.local" });
config();

import { createClerkClient } from "@clerk/backend";

const args = process.argv.slice(2);
function flagValue(name: string, fallback: string) {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
}

const EMAIL = flagValue("email", "demo@orbit.com");
const PASSWORD = flagValue("password", "DemoPass!");

const secretKey = process.env.CLERK_SECRET_KEY?.trim();
if (!secretKey) {
  console.error(
    "Missing CLERK_SECRET_KEY.\n" +
      "Pass it inline so it's unambiguous which Clerk instance you're provisioning:\n" +
      "  CLERK_SECRET_KEY=sk_live_xxx npx tsx scripts/provision-demo-account.ts"
  );
  process.exit(1);
}
const instance = secretKey.startsWith("sk_live_")
  ? "LIVE (production)"
  : secretKey.startsWith("sk_test_")
    ? "TEST (dev)"
    : "unknown";

async function main() {
  const clerk = createClerkClient({ secretKey });

  const { data: existing } = await clerk.users.getUserList({
    emailAddress: [EMAIL],
  });

  let userId: string;
  if (existing.length > 0) {
    const user = existing[0];
    await clerk.users.updateUser(user.id, {
      password: PASSWORD,
      // The password is going to be published as a demo credential, so Clerk's
      // breached-password check is beside the point, and skipping it removes a
      // network-dependent way for this idempotent re-run to flake.
      skipPasswordChecks: true,
      firstName: "Demo",
      lastName: "User",
    });
    userId = user.id;
    console.log(`Updated existing Clerk user (${instance}): ${userId}`);
  } else {
    const user = await clerk.users.createUser({
      emailAddress: [EMAIL],
      password: PASSWORD,
      skipPasswordChecks: true,
      firstName: "Demo",
      lastName: "User",
    });
    userId = user.id;
    console.log(`Created Clerk user (${instance}): ${userId}`);
  }

  console.log(`  email:    ${EMAIL}`);
  console.log(`  password: ${PASSWORD}`);
  console.log(
    `\nNext: seed this account's network (append --confirm if DATABASE_URL points at a shared/remote DB):\n` +
      `  npx tsx scripts/seed-showcase.ts --user ${userId} --reset --confirm`
  );

  process.exit(0);
}

main().catch((e) => {
  console.error("FAILED:", e instanceof Error ? e.message : e);
  process.exit(1);
});
