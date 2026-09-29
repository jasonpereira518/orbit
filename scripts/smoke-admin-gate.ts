/**
 * Verifies the admin allowlist gate across every environment shape that matters.
 *
 * This is the security boundary for the whole console, and its most dangerous failure mode
 * is demo mode: when Clerk keys are absent in development, `requireUserId()` *succeeds* and
 * returns the shared literal "demo-user". A gate that only checked "is there a user id"
 * would hand the console to anyone running the app locally.
 *
 * Run: npx tsx scripts/smoke-admin-gate.ts
 */
import { config } from "dotenv";
config({ path: ".env.local" });
config();

function check(label: string, condition: boolean) {
  if (!condition) throw new Error(`${label} failed`);
  console.log(`  ok  ${label}`);
}

type Env = {
  clerkKey?: string;
  adminIds?: string;
  nodeEnv?: string;
  demoAccess?: string;
};

/**
 * Re-imports the gate with a fresh module registry so env reads are re-evaluated.
 *
 * `demoAccess` and `nodeEnv` are set explicitly on EVERY call — including to `undefined`,
 * which deletes them. Without that, a developer who has `ADMIN_DEMO_ACCESS=1` in their
 * own `.env.local` (which is the point of the flag) would inherit it here, and the cases
 * below that assert the gate is CLOSED would quietly start testing the open one.
 */
async function withEnv(env: Env) {
  const prevClerk = process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY;
  const prevAdmin = process.env.ADMIN_USER_IDS;
  const prevDemo = process.env.ADMIN_DEMO_ACCESS;
  const prevNodeEnv = process.env.NODE_ENV;

  if (env.clerkKey === undefined) delete process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY;
  else process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY = env.clerkKey;

  if (env.adminIds === undefined) delete process.env.ADMIN_USER_IDS;
  else process.env.ADMIN_USER_IDS = env.adminIds;

  if (env.demoAccess === undefined) delete process.env.ADMIN_DEMO_ACCESS;
  else process.env.ADMIN_DEMO_ACCESS = env.demoAccess;

  // Defaults to "development" so the flag cases are testing the environment the flag is
  // actually for; the production case sets it explicitly.
  (process.env as Record<string, string | undefined>).NODE_ENV =
    env.nodeEnv ?? "development";

  const mod = await import("../src/lib/admin");

  const restore = () => {
    if (prevClerk === undefined) delete process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY;
    else process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY = prevClerk;
    if (prevAdmin === undefined) delete process.env.ADMIN_USER_IDS;
    else process.env.ADMIN_USER_IDS = prevAdmin;
    if (prevDemo === undefined) delete process.env.ADMIN_DEMO_ACCESS;
    else process.env.ADMIN_DEMO_ACCESS = prevDemo;
    (process.env as Record<string, string | undefined>).NODE_ENV = prevNodeEnv;
  };

  return { mod, restore };
}

async function main() {
  console.log("Admin gate");

  // Fully configured: the allowlisted id is admin, nobody else is.
  {
    const { mod, restore } = await withEnv({
      clerkKey: "pk_test_fake",
      adminIds: "user_jason",
    });
    check("access is enabled when configured", mod.adminAccessEnabled() === true);
    check("allowlisted id is admin", mod.isAdminUser("user_jason") === true);
    check("other id is not admin", mod.isAdminUser("user_someone") === false);
    check("null id is not admin", mod.isAdminUser(null) === false);
    check("empty id is not admin", mod.isAdminUser("") === false);
    restore();
  }

  // Multiple ids, comma and whitespace separated.
  {
    const { mod, restore } = await withEnv({
      clerkKey: "pk_test_fake",
      adminIds: "user_a, user_b\nuser_c",
    });
    check("parses comma-separated ids", mod.isAdminUser("user_b") === true);
    check("parses whitespace-separated ids", mod.isAdminUser("user_c") === true);
    restore();
  }

  // ADMIN_USER_IDS unset: the console is off entirely, even for a real Clerk user.
  {
    const { mod, restore } = await withEnv({ clerkKey: "pk_test_fake" });
    check("unset allowlist disables access", mod.adminAccessEnabled() === false);
    check("unset allowlist denies everyone", mod.isAdminUser("user_jason") === false);
    restore();
  }

  // Empty string is treated as unset, not as an allowlist containing "".
  {
    const { mod, restore } = await withEnv({
      clerkKey: "pk_test_fake",
      adminIds: "   ",
    });
    check("blank allowlist disables access", mod.adminAccessEnabled() === false);
    restore();
  }

  // DEMO MODE — the dangerous case. No Clerk key means requireUserId() returns
  // "demo-user" to anyone; the gate must be closed regardless of the allowlist.
  {
    const { mod, restore } = await withEnv({ adminIds: "user_jason" });
    check("no Clerk key disables access entirely", mod.adminAccessEnabled() === false);
    check("demo-user is never admin", mod.isAdminUser("demo-user") === false);
    check(
      "even a real id is denied without Clerk",
      mod.isAdminUser("user_jason") === false
    );
    restore();
  }

  // The specific misconfiguration that would be catastrophic.
  {
    const { mod, restore } = await withEnv({ adminIds: "demo-user" });
    check(
      "ADMIN_USER_IDS=demo-user grants nothing (no Clerk)",
      mod.isAdminUser("demo-user") === false
    );
    restore();
  }
  {
    const { mod, restore } = await withEnv({
      clerkKey: "pk_test_fake",
      adminIds: "demo-user",
    });
    check(
      "ADMIN_USER_IDS=demo-user grants nothing (with Clerk)",
      mod.isAdminUser("demo-user") === false
    );
    restore();
  }

  /* ------------------------------------------------------- ADMIN_DEMO_ACCESS ------ */

  // The console is unreachable without Clerk keys, which makes it the one screen nobody
  // can look at while building it. This flag opens it for local development only. Every
  // condition below is one of the doors that has to stay shut.

  {
    const { mod, restore } = await withEnv({ demoAccess: "1" });
    check("demo access opens the gate in development", mod.adminAccessEnabled() === true);
    check("...and admits demo-user", mod.isAdminUser("demo-user") === true);
    check(
      "...but still nobody else, since no allowlist can apply",
      mod.isAdminUser("user_jason") === false
    );
    restore();
  }

  // THE ONE THAT MATTERS: a built artifact ignores the flag. `next build` sets
  // NODE_ENV=production, so this is the state any real deployment is in.
  {
    const { mod, restore } = await withEnv({
      demoAccess: "1",
      nodeEnv: "production",
    });
    check("demo access is inert in a production build", mod.demoAdminEnabled() === false);
    check("...so the gate stays closed", mod.adminAccessEnabled() === false);
    check("...and demo-user is denied", mod.isAdminUser("demo-user") === false);
    restore();
  }

  // With Clerk configured the allowlist governs and the flag must not widen anything.
  {
    const { mod, restore } = await withEnv({
      clerkKey: "pk_test_fake",
      adminIds: "user_jason",
      demoAccess: "1",
    });
    check(
      "demo access does nothing once Clerk is configured",
      mod.demoAdminEnabled() === false
    );
    check("...the allowlist still governs", mod.isAdminUser("user_jason") === true);
    check("...and demo-user is still denied", mod.isAdminUser("demo-user") === false);
    restore();
  }

  // Opt-in means opt-in: only the exact value counts, so a stray "0"/"false"/"true" in an
  // environment does not quietly open the console.
  for (const value of ["0", "false", "true", "yes", ""]) {
    const { mod, restore } = await withEnv({ demoAccess: value });
    check(
      `ADMIN_DEMO_ACCESS=${JSON.stringify(value)} does not open the gate`,
      mod.demoAdminEnabled() === false && mod.isAdminUser("demo-user") === false
    );
    restore();
  }

  console.log("\nAll admin gate checks passed.");
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error("\n" + e.message);
    process.exit(1);
  });
