/**
 * Meetings are Pro and Lifetime only — at every entry point, not just in the UI.
 * Run: npx tsx scripts/smoke-meeting-gate.ts
 */
import "./smoke/_env";

import { eq } from "drizzle-orm";
import { getDb } from "../src/db";
import { userSettings } from "../src/db/schema";
import { entitlementsForPlan, FEATURE_DENIAL, isPaywallError, requireEntitlement } from "../src/lib/entitlements";
import { createMeetingSession } from "../src/actions/meetings";

const USER = "demo-user";
let failures = 0;
function check(label: string, ok: boolean, detail?: string) {
  if (ok) console.log(`  ok   ${label}`);
  else { failures++; console.error(`  FAIL ${label}${detail ? `\n       ${detail}` : ""}`); }
}

async function setPlan(plan: "free" | "orbit" | "lifetime") {
  const db = await getDb();
  await db.delete(userSettings).where(eq(userSettings.userId, USER));
  await db.insert(userSettings).values({
    userId: USER,
    ...(plan === "lifetime" ? { lifetimePurchasedAt: new Date() } : {}),
    ...(plan === "orbit" ? { subscriptionStatus: "active", subscriptionPlan: "orbit" } : {}),
  });
}

async function main() {
  console.log("\nentitlements");
  check("free cannot meet", entitlementsForPlan("free", "free").canUseMeetings === false);
  check("Pro can meet", entitlementsForPlan("orbit", "subscription").canUseMeetings === true);
  check("Lifetime can meet", entitlementsForPlan("lifetime", "lifetime").canUseMeetings === true);
  check("the denial names both paid plans", /Pro/.test(FEATURE_DENIAL.meetings) && /Lifetime/.test(FEATURE_DENIAL.meetings));

  // `requireMeetingsUser()` (src/lib/plan-guards.ts) is `requireUserId()` then
  // `requireEntitlement(userId, "meetings")`. This exercises that second half against the
  // real DB-backed plan resolution, the same way smoke-entitlements.ts exercises every
  // other feature key — deliberately WITHOUT going through demo mode: `isDemoAccount()`
  // (src/lib/demo-account.ts) treats every account as exempt from every gate whenever
  // `NODE_ENV=development`, which is also the only way `requireUserId()` can resolve an
  // identity without real Clerk keys. Flipping NODE_ENV to reach the action's auth step
  // would therefore ALSO lift the very paywall being tested, so the free/paid distinction
  // has to be proven at the `requireEntitlement` layer instead.
  console.log("\nrequireEntitlement(\"meetings\") — the guard requireMeetingsUser calls");
  await setPlan("free");
  let freeThrew: unknown = null;
  try {
    await requireEntitlement(USER, "meetings");
  } catch (err) {
    freeThrew = err;
  }
  check("a free account is refused", isPaywallError(freeThrew), String(freeThrew));

  await setPlan("orbit");
  let proThrew: unknown = null;
  try {
    await requireEntitlement(USER, "meetings");
  } catch (err) {
    proThrew = err;
  }
  check("a Pro account is allowed", proThrew === null, String(proThrew));

  await setPlan("lifetime");
  let lifetimeThrew: unknown = null;
  try {
    await requireEntitlement(USER, "meetings");
  } catch (err) {
    lifetimeThrew = err;
  }
  check("a Lifetime account is allowed", lifetimeThrew === null, String(lifetimeThrew));

  // End-to-end sanity: with a real (non-exempt) Pro plan already on the row, confirm the
  // actual server action — not just the guard in isolation — reaches the database and
  // creates a session. This has to run in demo mode (no Clerk keys locally), which is why
  // it comes after the paywall assertions above rather than standing in for them: demo
  // mode would let a FREE demo-user through too, so it cannot prove the gate on its own.
  console.log("\ncreateMeetingSession — the real action end to end, authenticated");
  delete process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY;
  delete process.env.CLERK_SECRET_KEY;
  process.env.ORBIT_DEMO_DATA = "off";
  (process.env as Record<string, string>).NODE_ENV = "development";
  const allowed = await createMeetingSession({ includesMic: true, recorderId: "r2" });
  check("a Pro account can start a meeting through the real action", allowed.ok === true, JSON.stringify(allowed));

  if (failures) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
  console.log("\nAll meeting gate checks passed");
  process.exit(0);
}

main().catch((err) => { console.error(err); process.exit(1); });
