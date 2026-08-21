/**
 * Grant (or revoke) a comped plan for an account.
 *
 * Comped plans win over every other billing source in `resolvePlan`, so this is how you
 * hand someone Orbit or Lifetime for free without involving Clerk or Stripe.
 *
 *   npx tsx scripts/grant-plan.ts someone@example.com lifetime
 *   npx tsx scripts/grant-plan.ts someone@example.com orbit
 *   npx tsx scripts/grant-plan.ts someone@example.com none
 *
 * Resolves through the `user_settings.email` column that the Clerk webhook mirrors, so
 * the account must have signed in (or fired a user.created/updated webhook) at least once.
 */
import { config } from "dotenv";
config({ path: ".env.local" });
config();

import { eq } from "drizzle-orm";
import { getDb } from "../src/db";
import { userSettings } from "../src/db/schema";

const VALID = ["orbit", "lifetime", "none"] as const;
type Grant = (typeof VALID)[number];

async function main() {
  const [emailArg, planArg] = process.argv.slice(2);

  if (!emailArg || !planArg) {
    console.error("Usage: tsx scripts/grant-plan.ts <email> <orbit|lifetime|none>");
    process.exit(1);
  }
  if (!VALID.includes(planArg as Grant)) {
    console.error(`Plan must be one of: ${VALID.join(", ")}`);
    process.exit(1);
  }

  const email = emailArg.trim().toLowerCase();
  const plan = planArg as Grant;
  const db = await getDb();

  const row = await db.query.userSettings.findFirst({
    where: eq(userSettings.email, email),
  });

  if (!row) {
    console.error(
      `No account found for ${email}. The user must sign in at least once so the Clerk webhook mirrors their address.`
    );
    process.exit(1);
  }

  await db
    .update(userSettings)
    .set({
      compedPlan: plan === "none" ? null : plan,
      updatedAt: new Date(),
    })
    .where(eq(userSettings.userId, row.userId));

  console.log(
    plan === "none"
      ? `Removed comped plan for ${email} (${row.userId}).`
      : `Granted "${plan}" to ${email} (${row.userId}).`
  );
}

main()
  .then(() => {
    // The pooled DB connection keeps the event loop alive; exit explicitly.
    process.exit(0);
  })
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
