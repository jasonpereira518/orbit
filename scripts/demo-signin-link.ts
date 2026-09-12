/**
 * Mint a one-click sign-in link for the demo account — no password, no emailed code.
 *
 * This exists because Clerk's "which verification code is required" behavior is
 * controlled by dashboard toggles this script has no access to (only the *preference*
 * between password and email-code is reachable via the Backend API — see
 * `clerk-prefer-password-signin.ts` — not whether password is enabled as a strategy at
 * all). A sign-in token sidesteps the question entirely: it's Clerk's own "ticket"
 * first-factor, a distinct path from password/email-code, so it works regardless of how
 * those are configured.
 *
 * The token is SINGLE-USE — that's a Clerk server-side property, not something this
 * script (or any expiry value) can turn off. `--expires-seconds` only controls how long
 * an UNUSED token stays valid; it does not make a token reusable after it's clicked once.
 * There is no "unlimited and reusable" option here — the closest thing to that is fixing
 * the real password sign-in (see the comment on `clerk-prefer-password-signin.ts`), which
 * is reusable forever because it isn't a token at all.
 *
 * Usage:
 *   CLERK_SECRET_KEY=sk_live_xxx npx tsx scripts/demo-signin-link.ts
 *   CLERK_SECRET_KEY=sk_live_xxx npx tsx scripts/demo-signin-link.ts --email you@x.com
 *   CLERK_SECRET_KEY=sk_live_xxx npx tsx scripts/demo-signin-link.ts --base-url https://orbit.jasonpereira.live
 *   CLERK_SECRET_KEY=sk_live_xxx npx tsx scripts/demo-signin-link.ts --expires-seconds 2592000
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
const BASE_URL = flagValue("base-url", "https://orbit.jasonpereira.live").replace(/\/$/, "");
// 30 days — the longest Clerk documents for this — so the link doesn't go stale before
// you get to it. Does NOT make it reusable; see the header comment.
const EXPIRES_IN_SECONDS = Number(flagValue("expires-seconds", String(30 * 24 * 60 * 60)));

const secretKey = process.env.CLERK_SECRET_KEY?.trim();
if (!secretKey) {
  console.error(
    "Missing CLERK_SECRET_KEY.\n" +
      "Pass it inline so it's unambiguous which Clerk instance you're minting a token in:\n" +
      "  CLERK_SECRET_KEY=sk_live_xxx npx tsx scripts/demo-signin-link.ts"
  );
  process.exit(1);
}

async function main() {
  const clerk = createClerkClient({ secretKey: secretKey! });

  const { data } = await clerk.users.getUserList({ emailAddress: [EMAIL] });
  const user = data[0];
  if (!user) {
    console.error(
      `No Clerk user found for ${EMAIL}.\n` +
        "Run scripts/provision-demo-account.ts first."
    );
    process.exit(1);
  }

  const signInToken = await clerk.signInTokens.createSignInToken({
    userId: user.id,
    expiresInSeconds: EXPIRES_IN_SECONDS,
  });

  // Point at the app's OWN sign-in page (not Clerk's Account Portal, which may not be
  // configured) — `<SignIn/>` auto-detects `__clerk_ticket` and completes the sign-in
  // with no prompt at all.
  const link = `${BASE_URL}/sign-in?__clerk_ticket=${encodeURIComponent(signInToken.token)}`;

  const days = Math.round(EXPIRES_IN_SECONDS / 86400);
  console.log(`One-click sign-in for ${EMAIL} — valid for ${days} day${days === 1 ? "" : "s"}, but SINGLE-USE:\n`);
  console.log(link);
  console.log(
    "\nOpen it in the browser you're presenting from. Signs straight in to /dashboard.\n" +
      "It stops working the instant it's opened once — the long expiry just means it won't\n" +
      "go stale sitting unused. Re-run this script for another one; there's no limit on how\n" +
      "many you can mint."
  );

  process.exit(0);
}

main().catch((e) => {
  console.error("FAILED:", e instanceof Error ? e.message : e);
  process.exit(1);
});
