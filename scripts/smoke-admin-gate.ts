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
};

/** Re-imports the gate with a fresh module registry so env reads are re-evaluated. */
async function withEnv(env: Env) {
  const prevClerk = process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY;
  const prevAdmin = process.env.ADMIN_USER_IDS;

  if (env.clerkKey === undefined) delete process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY;
  else process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY = env.clerkKey;

  if (env.adminIds === undefined) delete process.env.ADMIN_USER_IDS;
  else process.env.ADMIN_USER_IDS = env.adminIds;

  const mod = await import("../src/lib/admin");

  const restore = () => {
    if (prevClerk === undefined) delete process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY;
    else process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY = prevClerk;
    if (prevAdmin === undefined) delete process.env.ADMIN_USER_IDS;
    else process.env.ADMIN_USER_IDS = prevAdmin;
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

  console.log("\nAll admin gate checks passed.");
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error("\n" + e.message);
    process.exit(1);
  });
