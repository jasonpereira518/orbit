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
import "./smoke/_env";

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
  const prevNodeEnv = process.env.NODE_ENV;

  if (env.clerkKey === undefined) delete process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY;
  else process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY = env.clerkKey;

  if (env.adminIds === undefined) delete process.env.ADMIN_USER_IDS;
  else process.env.ADMIN_USER_IDS = env.adminIds;

  if (env.nodeEnv === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = env.nodeEnv;

  const mod = await import("../src/lib/admin");

  const restore = () => {
    if (prevClerk === undefined) delete process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY;
    else process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY = prevClerk;
    if (prevAdmin === undefined) delete process.env.ADMIN_USER_IDS;
    else process.env.ADMIN_USER_IDS = prevAdmin;
    if (prevNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = prevNodeEnv;
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

  // DEMO MODE, deployed shape — the dangerous case. No Clerk key and no dev server means
  // requireUserId() returns "demo-user" to anyone; the gate must be closed regardless of
  // the allowlist. NODE_ENV is explicitly non-development here: this is what a Clerk-less
  // production or preview deploy, or `next start` run locally, looks like.
  {
    const { mod, restore } = await withEnv({ adminIds: "user_jason", nodeEnv: "production" });
    check("no Clerk key disables access entirely", mod.adminAccessEnabled() === false);
    check("demo-user is never admin off localhost", mod.isAdminUser("demo-user") === false);
    check(
      "even a real id is denied without Clerk",
      mod.isAdminUser("user_jason") === false
    );
    restore();
  }

  // DEMO MODE, `next dev` shape — the one case that's meant to grant access. A worktree
  // with no Clerk keys should still be able to reach the console; `src/proxy.ts` carries
  // the matching exemption for the route to even get this far.
  {
    const { mod, restore } = await withEnv({ nodeEnv: "development" });
    check("no Clerk key still disables the allowlisted-caller gate", mod.adminAccessEnabled() === false);
    check("demo-user is admin under next dev", mod.isAdminUser("demo-user") === true);
    check("any other id is admin under next dev too", mod.isAdminUser("someone-else") === true);
    restore();
  }
  {
    // Confirms the exemption is NODE_ENV, not "no Clerk key" alone — a real Clerk-configured
    // `next dev` (someone testing the real allowlist locally) keeps the strict rule.
    const { mod, restore } = await withEnv({
      clerkKey: "pk_test_fake",
      adminIds: "user_jason",
      nodeEnv: "development",
    });
    check("a real id not on the allowlist is still denied under next dev", mod.isAdminUser("user_someone") === false);
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
