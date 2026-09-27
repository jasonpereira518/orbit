/**
 * The durable, once-only upgrade celebration.
 *
 * What this guards is the thing a localStorage key cannot do. The client watcher's key is
 * per-device and per-browser-profile, so without a server record an account that upgrades
 * on a phone celebrates a second time on a laptop, and clearing site data replays it
 * forever. These assertions are about "exactly once, across devices, permanently".
 *
 * Run: npx tsx scripts/smoke-plan-upgrade-claim.ts
 */
import "./smoke/_env";

import { eq, inArray } from "drizzle-orm";
import { getDb } from "../src/db";
import { planUpgradeEvents, userSettings } from "../src/db/schema";
import {
  claimPendingPlanUpgrade,
  queuePlanUpgradeTransition,
} from "../src/lib/plan-upgrade-events";
import { purgeUserData } from "../src/lib/user-data";
import { ensureUserSettings, setCompedPlan } from "../src/lib/user-settings";

const PREFIX = "smoke-upgrade-";
const USER = `${PREFIX}account`;
const OTHER = `${PREFIX}other`;
const IDS = [USER, OTHER, `${PREFIX}comped`];

const FREE = {};
const ORBIT = { subscriptionPlan: "orbit" as const, subscriptionStatus: "active" as const };
const LIFETIME = { lifetimePurchasedAt: new Date() };

function check(label: string, condition: boolean, detail?: string) {
  if (!condition) throw new Error(`${label} failed${detail ? `: ${detail}` : ""}`);
  console.log(`  ok  ${label}`);
}

async function pendingCount(userId: string) {
  const db = await getDb();
  const rows = await db.query.planUpgradeEvents.findMany({
    where: eq(planUpgradeEvents.userId, userId),
  });
  return rows.length;
}

async function cleanup() {
  const db = await getDb();
  await db.delete(planUpgradeEvents).where(inArray(planUpgradeEvents.userId, IDS));
  await db.delete(userSettings).where(inArray(userSettings.userId, IDS));
}

async function main() {
  console.log("Plan upgrade claim");
  await cleanup();
  for (const id of IDS) await ensureUserSettings(id);

  /* ------------------------------------------------------------------ queueing rules */

  check(
    "free -> free queues nothing",
    (await queuePlanUpgradeTransition({
      userId: USER, before: FREE, after: FREE, eventKey: `${USER}-noop`,
    })) === null
  );

  const first = await queuePlanUpgradeTransition({
    userId: USER, before: FREE, after: ORBIT, eventKey: `${USER}-sub-1`,
  });
  check("free -> orbit queues one event", first !== null);
  check("...with the resolved plan and source", first?.plan === "orbit" && first?.source === "subscription");

  // The partial unique index is what makes concurrent webhook deliveries safe.
  const dupe = await queuePlanUpgradeTransition({
    userId: USER, before: FREE, after: ORBIT, eventKey: `${USER}-sub-2`,
  });
  check("a second pending upgrade to the same plan is refused", dupe === null);
  check("still exactly one row", (await pendingCount(USER)) === 1);

  // Same eventKey twice is the provider-retry case, caught by the unique key.
  const replay = await queuePlanUpgradeTransition({
    userId: USER, before: FREE, after: LIFETIME, eventKey: `${USER}-sub-1`,
  });
  check("a replayed eventKey is refused", replay === null);

  check(
    "a downgrade queues nothing",
    (await queuePlanUpgradeTransition({
      userId: USER, before: ORBIT, after: FREE, eventKey: `${USER}-down`,
    })) === null
  );

  /* ------------------------------------------------------------------------ claiming */

  const claimed = await claimPendingPlanUpgrade(USER);
  check("the queued event claims once", claimed?.plan === "orbit");
  check("a second claim returns nothing", (await claimPendingPlanUpgrade(USER)) === null);
  check("a third claim still returns nothing", (await claimPendingPlanUpgrade(USER)) === null);

  // This is the cross-device property: the row survives, so no other device can re-claim.
  check("the claimed row is kept, not deleted", (await pendingCount(USER)) === 1);

  /* ------------------------------------- re-upgrade after the first was claimed */

  const second = await queuePlanUpgradeTransition({
    userId: USER, before: ORBIT, after: LIFETIME, eventKey: `${USER}-lifetime`,
  });
  check("a genuine second upgrade queues again", second?.plan === "lifetime");
  check("it claims once", (await claimPendingPlanUpgrade(USER))?.plan === "lifetime");
  check("and not twice", (await claimPendingPlanUpgrade(USER)) === null);

  /* ------------------------------------------------------------------------- comps */

  // Comps move the resolved plan without any subscription or purchase being written, so
  // they have to queue at their own writer. Missing this is what silently broke
  // `triggerDemoCelebration`, which comps the demo account.
  const COMPED = `${PREFIX}comped`;
  await ensureUserSettings(COMPED);
  await setCompedPlan(COMPED, "lifetime", { note: "smoke" });
  check(
    "comping a plan queues a celebration",
    (await pendingCount(COMPED)) === 1,
    `${await pendingCount(COMPED)}`
  );
  const compClaim = await claimPendingPlanUpgrade(COMPED);
  check("...which claims once as a comp", compClaim?.plan === "lifetime" && compClaim?.source === "comp");
  check("...and not twice", (await claimPendingPlanUpgrade(COMPED)) === null);

  // Revoking is a downgrade, so it must queue nothing; re-granting must celebrate again.
  await setCompedPlan(COMPED, null, {});
  check("revoking a comp queues nothing", (await pendingCount(COMPED)) === 1);
  await setCompedPlan(COMPED, "orbit", { note: "smoke again" });
  check("re-granting queues a fresh celebration", (await pendingCount(COMPED)) === 2);
  check("...which claims", (await claimPendingPlanUpgrade(COMPED))?.plan === "orbit");

  /* ------------------------------------------------------------------- scope per user */

  await queuePlanUpgradeTransition({
    userId: OTHER, before: FREE, after: ORBIT, eventKey: `${OTHER}-sub`,
  });
  check("another account's event is not claimable here", (await claimPendingPlanUpgrade(USER)) === null);
  check("...but is claimable by its owner", (await claimPendingPlanUpgrade(OTHER))?.plan === "orbit");

  /* ----------------------------------------------------------------------- deletion */

  check("rows exist before the purge", (await pendingCount(USER)) === 2);
  await purgeUserData(USER);
  check("purge removes the account's events", (await pendingCount(USER)) === 0);
  check("...and leaves other accounts alone", (await pendingCount(OTHER)) === 1);

  console.log("Done.");
}

main()
  .then(async () => {
    await cleanup();
    process.exit(0);
  })
  .catch(async (e) => {
    console.error(e);
    await cleanup().catch(() => {});
    process.exit(1);
  });
