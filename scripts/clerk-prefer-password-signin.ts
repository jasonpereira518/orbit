/**
 * Make Clerk prefer password over an emailed verification code at sign-in.
 *
 * Why this exists: the demo account (demo@orbit.com) has a password set and a verified
 * email, but Clerk's default instance behavior still offers/prefers an emailed
 * one-time code as the first-factor strategy when both are available — and nobody has
 * access to that inbox to retrieve the code. Clerk has no per-account override for this;
 * `preferredSignInStrategyWhenPasswordRequired` is an instance-wide setting. Setting it
 * to "password" only changes behavior for accounts that already have a password — any
 * passwordless account (OAuth-only, etc.) is unaffected.
 *
 * Usage:
 *   CLERK_SECRET_KEY=sk_live_xxx npx tsx scripts/clerk-prefer-password-signin.ts
 *
 * To revert to Clerk's default (prefer emailed code):
 *   CLERK_SECRET_KEY=sk_live_xxx npx tsx scripts/clerk-prefer-password-signin.ts --revert
 */
import { config } from "dotenv";
config({ path: ".env.local" });
config();

import { createClerkClient } from "@clerk/backend";

const revert = process.argv.includes("--revert");

const secretKey = process.env.CLERK_SECRET_KEY?.trim();
if (!secretKey) {
  console.error(
    "Missing CLERK_SECRET_KEY.\n" +
      "Pass it inline so it's unambiguous which Clerk instance you're changing:\n" +
      "  CLERK_SECRET_KEY=sk_live_xxx npx tsx scripts/clerk-prefer-password-signin.ts"
  );
  process.exit(1);
}

async function main() {
  const clerk = createClerkClient({ secretKey: secretKey! });
  // Empty string clears the override back to Clerk's own default; "password" sets it.
  const value = revert ? "" : "password";
  await clerk.instance.update({ preferredSignInStrategyWhenPasswordRequired: value });
  console.log(
    revert
      ? "Reverted — Clerk's default sign-in preference is restored."
      : "Done — accounts with a password (including the demo account) now sign in with password, no emailed code."
  );
  process.exit(0);
}

main().catch((e) => {
  console.error("FAILED:", e instanceof Error ? e.message : e);
  process.exit(1);
});
