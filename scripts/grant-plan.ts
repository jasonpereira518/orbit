/**
 * Grant (or revoke) a comped plan for an account.
 *
 * Comped plans win over every other billing source in `resolvePlan`, so this is how you
 * hand someone Orbit or Lifetime for free without involving Clerk or Stripe.
 *
 *   npx tsx scripts/grant-plan.ts someone@example.com lifetime "early adopter"
 *   npx tsx scripts/grant-plan.ts someone@example.com orbit
 *   npx tsx scripts/grant-plan.ts someone@example.com none
 *
 * The optional third argument is the reason, stored on the row. Writes go through
 * `setCompedPlan` so this and the admin console cannot drift apart.
 *
 * Resolves through the `user_settings.email` column that the Clerk webhook mirrors, so
 * the account must have signed in (or fired a user.created/updated webhook) at least once.
 */
import { config } from "dotenv";
config({ path: ".env.local" });
config();

import { findUsersByEmail, setCompedPlan } from "../src/lib/user-settings";

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

  const matches = await findUsersByEmail(email);

  if (matches.length === 0) {
    console.error(
      `No account found for ${email}. The user must sign in at least once so the Clerk webhook mirrors their address.`
    );
    process.exit(1);
  }

  // `user_settings.email` has no unique constraint on purpose — two accounts may
  // legitimately transit the same address. Refuse rather than guess.
  if (matches.length > 1) {
    console.error(`${matches.length} accounts share ${email}:`);
    for (const m of matches) {
      console.error(`  ${m.userId}  created ${m.createdAt.toISOString()}`);
    }
    console.error("Resolve by user id in the admin console instead.");
    process.exit(1);
  }

  const row = matches[0];

  await setCompedPlan(row.userId, plan === "none" ? null : plan, {
    note: process.argv[4]?.trim() || "granted via scripts/grant-plan.ts",
  });

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
