/**
 * Per-account unit economics.
 *
 * THE ASSERTION THIS FILE EXISTS FOR is that BYOK spend is never counted as Orbit's cost.
 * Production is strictly BYOK, so nearly all AI spend belongs to the user — and the old
 * Money screen showed the total as "money out", which meant the number pointed the wrong
 * way: the more users spent on their own keys, the worse Orbit's costs appeared. That
 * mistake produces a perfectly plausible screen, which is why it needs a test rather than
 * a careful reading.
 *
 * The second is that a comped account contributes no revenue however its billing columns
 * read. Comps outrank real billing state in `resolvePlan`, so an account can look like a
 * paying subscriber in every column while paying nothing.
 *
 * Run: npx tsx scripts/smoke-unit-economics.ts
 */
import { config } from "dotenv";
config({ path: ".env.local" });
config();

import { eq, inArray } from "drizzle-orm";
import { getDb } from "../src/db";
import { billingEvents, infraCosts, usageEvents, userSettings } from "../src/db/schema";
import {
  accountEconomics,
  concentration,
  formatCents,
  getUnitEconomics,
  mrrReconciliation,
} from "../src/lib/admin-economics";
import { loadAdminUserRows } from "../src/lib/admin-metrics";
import { setInfraCost, monthStart } from "../src/lib/infra-costs";
import { ensureUserSettings } from "../src/lib/user-settings";

const PREFIX = "smoke-econ-";
const PAYER = `${PREFIX}payer`;
const COMPED = `${PREFIX}comped`;
const FREE = `${PREFIX}free`;
const ALL = [PAYER, COMPED, FREE];
const PROVIDER = `${PREFIX}vercel`;

function check(label: string, condition: boolean, detail?: string) {
  if (!condition) throw new Error(`${label} failed${detail ? `: ${detail}` : ""}`);
  console.log(`  ok  ${label}`);
}

async function cleanup() {
  const db = await getDb();
  await db.delete(usageEvents).where(inArray(usageEvents.userId, ALL));
  await db.delete(billingEvents).where(inArray(billingEvents.userId, ALL));
  await db.delete(infraCosts).where(eq(infraCosts.provider, PROVIDER));
  await db.delete(userSettings).where(inArray(userSettings.userId, ALL));
}

async function usage(userId: string, keyOwner: "user" | "orbit", costMicros: number) {
  const db = await getDb();
  await db.insert(usageEvents).values({
    userId,
    operation: "smoke.econ",
    provider: "gemini",
    model: "gemini-3.5-flash",
    kind: "completion",
    keyOwner,
    success: 1,
    estimatedCostMicros: costMicros,
  });
}

async function main() {
  await cleanup();
  for (const id of ALL) await ensureUserSettings(id);

  const db = await getDb();
  const future = new Date(Date.now() + 20 * 86_400_000);

  // A real subscriber.
  await db
    .update(userSettings)
    .set({
      email: `${PAYER}@example.test`,
      subscriptionPlan: "orbit",
      subscriptionStatus: "active",
      subscriptionPeriodEnd: future,
    })
    .where(eq(userSettings.userId, PAYER));

  // Comped Orbit Pro: looks like a subscriber in every billing column, pays nothing, and
  // spends Orbit's own credits. The archetype this screen exists to surface.
  await db
    .update(userSettings)
    .set({
      email: `${COMPED}@example.test`,
      compedPlan: "orbit",
      subscriptionPlan: "orbit",
      subscriptionStatus: "active",
      subscriptionPeriodEnd: future,
    })
    .where(eq(userSettings.userId, COMPED));

  // $2.00 on the user's own key, $0.50 on Orbit's.
  await usage(PAYER, "user", 2_000_000);
  await usage(COMPED, "orbit", 500_000);

  const rows = (await loadAdminUserRows()).filter((r) => ALL.includes(r.userId));
  const accounts = await accountEconomics(rows);
  const byId = new Map(accounts.map((a) => [a.userId, a]));

  const payer = byId.get(PAYER)!;
  const comped = byId.get(COMPED)!;
  const free = byId.get(FREE)!;

  /* ------------------------------------------------------ BYOK is not Orbit's cost */

  check("a BYOK account costs Orbit nothing in AI", payer.aiCostCents === 0);
  check(
    "...and their own spend is reported separately",
    payer.byokCostCents === 200,
    formatCents(payer.byokCostCents)
  );
  check(
    "AI paid on Orbit's key IS a cost to serve",
    comped.aiCostCents === 50,
    formatCents(comped.aiCostCents)
  );

  /* --------------------------------------------------------------- comps pay nothing */

  check("a paying subscriber contributes revenue", payer.revenueCents === 500);
  check(
    "a comped account contributes none, despite an active subscription row",
    comped.revenueCents === 0,
    formatCents(comped.revenueCents)
  );
  check("a free account contributes none", free.revenueCents === 0);

  /* ------------------------------------------------------------------------- margin */

  check("margin is revenue minus cost", payer.marginCents === 500);
  check("a comped account with real costs is underwater", comped.marginCents === -50);

  // The ordering is the point of the screen: the money-losing accounts must be first.
  check(
    "the worst margin sorts to the top",
    accounts[0]?.userId === COMPED,
    accounts.map((a) => `${a.userId}:${a.marginCents}`).join(" ")
  );

  /* ------------------------------------------------------------------ concentration */

  const conc = concentration(accounts);
  check(
    "one paying account is 100% of revenue",
    conc.topShareOfRevenue === 100,
    String(conc.topShareOfRevenue)
  );
  check("...and is named", conc.topRevenueUser === PAYER);

  // Undefined, not zero. "0% concentration" reads as healthy diversification; the truth is
  // that there is no revenue to concentrate.
  const noRevenue = concentration(
    accounts.map((a) => ({ ...a, revenueCents: 0 }))
  );
  check(
    "concentration of zero revenue is null, not 0%",
    noRevenue.topShareOfRevenue === null
  );

  /* --------------------------------------------------------------------- break-even */

  await setInfraCost({ provider: PROVIDER, month: new Date(), amountCents: 2000 });
  const econ = await getUnitEconomics(rows);

  check("fixed cost is picked up for the current month", econ.fixedCostCents >= 2000);
  check("the month is recognised as entered", econ.fixedCostMissing === false);
  check(
    "break-even divides fixed cost by contribution per SUBSCRIBER",
    econ.breakEvenSubscribers !== null && econ.breakEvenSubscribers > 0,
    String(econ.breakEvenSubscribers)
  );

  // Free accounts are what the paying ones have to cover. Averaging their zero revenue
  // into contribution would flatter the number and understate the subscribers needed.
  check(
    "free accounts do not dilute contribution per subscriber",
    econ.contributionPerSubscriberCents === 500,
    String(econ.contributionPerSubscriberCents)
  );

  check(
    "net is revenue minus Orbit's costs only",
    econ.netCents === econ.mrrCents - econ.variableCostCents - econ.fixedCostCents
  );
  check(
    "BYOK spend is excluded from net",
    econ.byokCostCents === 200 && !String(econ.netCents).includes("NaN")
  );

  /* -------------------------------------------------------- the dropped-webhook check */

  // Live state says $5/mo; the ledger has no rows for it. That disagreement is the only
  // signal Orbit has that a billing webhook went missing.
  const drift = await mrrReconciliation();
  check(
    "a subscription with no ledger row shows as drift",
    drift.driftCents !== 0 && !drift.agrees,
    `ledger ${drift.ledgerCents} vs live ${drift.liveCents}`
  );

  await db.insert(billingEvents).values({
    source: "clerk",
    eventId: `${PREFIX}evt`,
    kind: "new",
    userId: PAYER,
    mrrDeltaCents: 500,
    effectiveAt: new Date(),
  });

  const reconciled = await mrrReconciliation();
  check(
    "recording the movement clears the drift",
    reconciled.agrees,
    `ledger ${reconciled.ledgerCents} vs live ${reconciled.liveCents}`
  );

  /* ------------------------------------------------------------------- formatting */

  check("cents format as dollars", formatCents(2550) === "$25.50");
  check("a negative margin keeps its sign", formatCents(-50) === "-$0.50");
  check("the month key normalises", monthStart(new Date()).getUTCDate() === 1);

  /* ------------------------------------------------------------------ the screen itself */

  // The page gates itself via the layout, not in the component, so it can be invoked
  // directly — the same technique `smoke-admin-render.ts` uses. This proves the loaders
  // run and the tree builds; the console is unreachable in a browser locally because
  // `proxy.ts` 404s /admin without Clerk keys.
  const { default: AdminBillingPage } = await import(
    "../src/app/(admin)/admin/billing/page"
  );
  const tree = await AdminBillingPage();
  check("the Money screen renders", tree != null);

  await cleanup();
  console.log("\nAll unit-economics checks passed.");
}

main()
  .then(() => process.exit(0))
  .catch(async (e) => {
    console.error(e);
    await cleanup().catch(() => {});
    process.exit(1);
  });
