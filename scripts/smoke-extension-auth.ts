/**
 * The extension API's authentication, refusal by refusal.
 *
 * `requireExtensionUser` (src/lib/extension/auth.ts) is the only thing between the public
 * internet and the extension's write API: `/api/extension(.*)` is listed as PUBLIC in
 * src/lib/public-routes.ts so an unauthenticated call gets a JSON 401 rather than a 302, which
 * means `clerkMiddleware` never refuses anything there on its own. Until now only the happy
 * path (the local-dev shared secret, in smoke-behavior-golden) was exercised. This pins the
 * doors that must stay shut:
 *
 *   - the dev shared secret is honoured ONLY under `NODE_ENV=development`. A production (or
 *     test) build that happens to carry `EXTENSION_DEV_SECRET` must ignore it entirely —
 *     otherwise the secret is a skeleton key to `EXTENSION_DEV_USER_ID`'s account;
 *   - a wrong, missing, or differently-sized `x-orbit-dev-secret` is refused (not thrown);
 *   - with Clerk unconfigured there is no fallback user: ExtensionUnauthorizedError;
 *   - a Clerk failure, or a session with no user, is ExtensionUnauthorizedError;
 *   - a suspended account and an account stealth is holding are refused, the same two gates
 *     `requireUserId` applies.
 *
 * Clerk's `auth()` / `clerkClient()` are stubbed by planting a module in `require.cache`
 * before the module under test is loaded (with `require`, so it binds to the stub). The
 * stub never talks to Clerk. `site_settings` is global state, so it is snapshotted and
 * restored, the same discipline as smoke-site-access.
 *
 * Run: npx tsx scripts/smoke-extension-auth.ts
 */
import "./smoke/_env";
import { run } from "./smoke/_env";

import { createRequire } from "node:module";
import { eq } from "drizzle-orm";
import { getDb } from "../src/db";
import { adminAuditLog, siteSettings, userSettings } from "../src/db/schema";
import { checker } from "./smoke/check";
import { fakeUserId, purgeUsers } from "./smoke/factories";

const nodeRequire = createRequire(__filename);

// --- The Clerk stub --------------------------------------------------------------------------
type ClerkUser = { createdAt: number; publicMetadata: Record<string, unknown> };
const clerk = {
  /** What `auth()` answers with; `"throw"` simulates a missing middleware / Clerk fault. */
  session: null as { userId: string | null } | "throw" | null,
  users: new Map<string, ClerkUser>(),
  getUserCalls: 0,
};

{
  const path = nodeRequire.resolve("@clerk/nextjs/server");
  const real = nodeRequire("@clerk/nextjs/server") as Record<string, unknown>;
  const fake = {
    ...real,
    auth: async () => {
      if (clerk.session === "throw") throw new Error("clerkMiddleware not detected (smoke stub)");
      return clerk.session ?? { userId: null };
    },
    clerkClient: async () => ({
      users: {
        getUser: async (id: string) => {
          clerk.getUserCalls++;
          const u = clerk.users.get(id);
          if (!u) throw new Error(`no such Clerk user (smoke stub): ${id}`);
          return u;
        },
      },
    }),
  };
  const Module = nodeRequire("node:module") as new (id: string) => {
    filename: string;
    loaded: boolean;
    exports: unknown;
  };
  const stub = new Module(path);
  stub.filename = path;
  stub.loaded = true;
  stub.exports = fake;
  (nodeRequire.cache as Record<string, unknown>)[path] = stub;
}

// Loaded through `require` AFTER the stub is planted, so its `@clerk/nextjs/server` is the stub.
const ext = nodeRequire("../src/lib/extension/auth") as typeof import("../src/lib/extension/auth");
const siteAccess = nodeRequire("../src/lib/site-access") as typeof import("../src/lib/site-access");
const { ExtensionUnauthorizedError, requireExtensionUser, DEV_SECRET_HEADER } = ext;

const DEV_SECRET = "smoke-extension-dev-secret-not-real";
const ADMIN = fakeUserId("extauth_admin");
const DEV_USER = fakeUserId("extauth_dev");
const NORMAL = fakeUserId("extauth_normal");
const SUSPENDED = fakeUserId("extauth_suspended");
const HELD = fakeUserId("extauth_held");
const INVITED = fakeUserId("extauth_invited");
const EARLY = fakeUserId("extauth_early");
const ALL = [ADMIN, DEV_USER, NORMAL, SUSPENDED, HELD, INVITED, EARLY];

const env = process.env as Record<string, string | undefined>;
function setEnv(over: Record<string, string | undefined>) {
  for (const key of [
    "NODE_ENV",
    "EXTENSION_DEV_SECRET",
    "EXTENSION_DEV_USER_ID",
    "NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY",
  ]) {
    delete env[key];
  }
  for (const [k, v] of Object.entries(over)) if (v !== undefined) env[k] = v;
}

function req(secret?: string): Request {
  return new Request("http://localhost/api/extension/me", {
    headers: secret === undefined ? {} : { [DEV_SECRET_HEADER]: secret },
  });
}

/** "ok:<userId>" or "unauthorized:<message>"; anything else is an unexpected throw. */
async function outcome(r: Request): Promise<string> {
  try {
    const { userId } = await requireExtensionUser(r);
    return `ok:${userId}`;
  } catch (err) {
    if (err instanceof ExtensionUnauthorizedError) return `unauthorized:${err.message}`;
    return `threw:${err instanceof Error ? `${err.name}: ${err.message}` : String(err)}`;
  }
}

run(async () => {
  const t = checker();
  const db = await getDb();
  await purgeUsers(db, ALL);
  const siteBefore = await db.query.siteSettings.findFirst({ where: eq(siteSettings.id, 1) });
  const stealthEnvBefore = env.SITE_STEALTH;
  const adminIdsBefore = env.ADMIN_USER_IDS;
  const demoDataBefore = env.ORBIT_DEMO_DATA;
  // No account here is an admin, and no account is seeded with demo data on first touch.
  delete env.ADMIN_USER_IDS;
  env.ORBIT_DEMO_DATA = "off";

  try {
    // --- The dev shared secret ---------------------------------------------------------------
    console.log("The local-dev shared secret is honoured only in development…");
    setEnv({ NODE_ENV: "development", EXTENSION_DEV_SECRET: DEV_SECRET, EXTENSION_DEV_USER_ID: DEV_USER });
    t.check(
      "development + the right secret resolves to EXTENSION_DEV_USER_ID (positive control)",
      (await outcome(req(DEV_SECRET))) === `ok:${DEV_USER}`
    );
    t.check(
      "surrounding whitespace on the header is trimmed, as on the secret",
      (await outcome(req(`  ${DEV_SECRET} `))) === `ok:${DEV_USER}`
    );
    // From here on no dev-path call may have created a settings row for the dev user.
    await purgeUsers(db, [DEV_USER]);

    const notConfigured = (o: string) => o.startsWith("unauthorized:") && o.includes("not configured");
    let o = await outcome(req("wrong-secret-not-real"));
    t.check("development + a wrong secret is refused", notConfigured(o), o);
    o = await outcome(req(`${DEV_SECRET}-and-more`));
    t.check("development + a longer secret is refused, not thrown", notConfigured(o), o);
    o = await outcome(req(DEV_SECRET.slice(0, -1)));
    t.check("development + a one-char-short secret is refused", notConfigured(o), o);
    o = await outcome(req());
    t.check("development + no header is refused", notConfigured(o), o);
    o = await outcome(req(""));
    t.check("development + an empty header is refused", notConfigured(o), o);

    setEnv({ NODE_ENV: "development", EXTENSION_DEV_SECRET: "   ", EXTENSION_DEV_USER_ID: DEV_USER });
    o = await outcome(req("   "));
    t.check("a whitespace-only EXTENSION_DEV_SECRET opens nothing, even to a matching header", notConfigured(o), o);
    setEnv({ NODE_ENV: "development", EXTENSION_DEV_USER_ID: DEV_USER });
    o = await outcome(req(""));
    t.check("an unset EXTENSION_DEV_SECRET opens nothing", notConfigured(o), o);

    for (const nodeEnv of ["production", "test"]) {
      setEnv({ NODE_ENV: nodeEnv, EXTENSION_DEV_SECRET: DEV_SECRET, EXTENSION_DEV_USER_ID: DEV_USER });
      o = await outcome(req(DEV_SECRET));
      t.check(
        `NODE_ENV=${nodeEnv} ignores a configured dev secret, even when the header matches`,
        notConfigured(o),
        o
      );
      // With Clerk configured but no session, the secret must not stand in for one either.
      setEnv({
        NODE_ENV: nodeEnv,
        EXTENSION_DEV_SECRET: DEV_SECRET,
        EXTENSION_DEV_USER_ID: DEV_USER,
        NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: "pk_test_smoke_not_real",
      });
      clerk.session = { userId: null };
      o = await outcome(req(DEV_SECRET));
      t.check(
        `NODE_ENV=${nodeEnv} with Clerk configured: the secret does not replace a session`,
        o === "unauthorized:Not signed in to Orbit",
        o
      );
    }
    const devRow = await db.query.userSettings.findFirst({ where: eq(userSettings.userId, DEV_USER) });
    t.check("no refused call bootstrapped the dev user's account", devRow === undefined);

    // --- Clerk --------------------------------------------------------------------------------
    console.log("\nClerk sessions…");
    setEnv({ NODE_ENV: "production" });
    clerk.session = { userId: NORMAL };
    o = await outcome(req());
    t.check(
      "Clerk not configured → ExtensionUnauthorizedError, even with a session available",
      notConfigured(o),
      o
    );
    t.check(
      "…and no account row was created for the would-be user",
      (await db.query.userSettings.findFirst({ where: eq(userSettings.userId, NORMAL) })) === undefined
    );

    setEnv({ NODE_ENV: "production", NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: "pk_test_smoke_not_real" });
    clerk.session = "throw";
    o = await outcome(req());
    t.check("a Clerk fault (no middleware) is ExtensionUnauthorizedError", o === "unauthorized:Not signed in to Orbit", o);
    clerk.session = { userId: null };
    o = await outcome(req());
    t.check("a signed-out session is ExtensionUnauthorizedError", o === "unauthorized:Not signed in to Orbit", o);
    clerk.session = { userId: NORMAL };
    o = await outcome(req());
    t.check("a signed-in, unremarkable account is let in (positive control)", o === `ok:${NORMAL}`, o);

    // --- Suspension ---------------------------------------------------------------------------
    console.log("\nAccount gates…");
    clerk.session = { userId: SUSPENDED };
    t.check("the suspended account is let in before it is suspended", (await outcome(req())) === `ok:${SUSPENDED}`);
    await db.update(userSettings).set({ suspendedAt: new Date() }).where(eq(userSettings.userId, SUSPENDED));
    o = await outcome(req());
    t.check("a suspended account is refused", o === "unauthorized:This Orbit account is suspended.", o);
    await db.update(userSettings).set({ suspendedAt: null }).where(eq(userSettings.userId, SUSPENDED));
    t.check("lifting the suspension restores access", (await outcome(req())) === `ok:${SUSPENDED}`);

    // --- Stealth ------------------------------------------------------------------------------
    // Rows are written with explicit createdAt on either side of stealth_since, so the rule
    // is decided by data, not by how fast this script runs.
    await siteAccess.setStealth(ADMIN, false);
    const mode = await siteAccess.setStealth(ADMIN, true);
    const since = mode.stealthSince!;
    const before = new Date(since.getTime() - 60_000);
    const after = new Date(since.getTime() + 60_000);
    await db.insert(userSettings).values([
      { userId: HELD, createdAt: after },
      { userId: INVITED, createdAt: after },
      { userId: EARLY, createdAt: before },
    ]);
    clerk.users.set(HELD, { createdAt: after.getTime(), publicMetadata: {} });
    clerk.users.set(INVITED, { createdAt: after.getTime(), publicMetadata: { siteInvite: { by: ADMIN } } });

    clerk.session = { userId: HELD };
    o = await outcome(req());
    t.check(
      "an uninvited account created during stealth is refused",
      o === "unauthorized:This account is waiting for an invitation.",
      o
    );
    const heldRow = await db.query.userSettings.findFirst({ where: eq(userSettings.userId, HELD) });
    t.check("…and is not stamped as cleared", heldRow?.stealthClearedAt === null);

    clerk.session = { userId: INVITED };
    o = await outcome(req());
    t.check("an invited account created during stealth is let in", o === `ok:${INVITED}`, o);
    clerk.session = { userId: EARLY };
    o = await outcome(req());
    t.check("an account that predates stealth is let in", o === `ok:${EARLY}`, o);

    // A suspension and a hold together: the suspension message wins, and neither lets it in.
    await db.update(userSettings).set({ suspendedAt: new Date() }).where(eq(userSettings.userId, HELD));
    clerk.session = { userId: HELD };
    o = await outcome(req());
    t.check("suspended AND held is refused (suspension checked first)", o === "unauthorized:This Orbit account is suspended.", o);

    await siteAccess.setStealth(ADMIN, false);
    await db.update(userSettings).set({ suspendedAt: null }).where(eq(userSettings.userId, HELD));
    o = await outcome(req());
    t.check("switching stealth off lets the held account in", o === `ok:${HELD}`, o);
  } finally {
    await db.delete(siteSettings).where(eq(siteSettings.id, 1));
    if (siteBefore) await db.insert(siteSettings).values(siteBefore);
    (globalThis as { orbitSiteMode?: unknown }).orbitSiteMode = undefined;
    await db.delete(adminAuditLog).where(eq(adminAuditLog.adminUserId, ADMIN));
    await purgeUsers(db, ALL);
    if (stealthEnvBefore === undefined) delete env.SITE_STEALTH;
    else env.SITE_STEALTH = stealthEnvBefore;
    if (adminIdsBefore !== undefined) env.ADMIN_USER_IDS = adminIdsBefore;
    if (demoDataBefore === undefined) delete env.ORBIT_DEMO_DATA;
    else env.ORBIT_DEMO_DATA = demoDataBefore;
  }

  t.done("extension auth");
});
