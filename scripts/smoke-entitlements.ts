/**
 * Exercises the paywall end-to-end against the local PGlite database:
 * plan resolution precedence, the free contact cap, bulk truncation, and the rule that
 * over-cap users never lose access to what they already have.
 *
 * Run: npx tsx scripts/smoke-entitlements.ts
 */
import "./smoke/_env";

import { and, count, eq } from "drizzle-orm";
import { getDb } from "../src/db";
import { contacts, userSettings } from "../src/db/schema";
import {
  FREE_CONTACT_LIMIT,
  getEntitlements,
  isPaywallError,
  requireEntitlement,
  resolvePlan,
} from "../src/lib/entitlements";
import { isDemoAccount } from "../src/lib/demo-account";
import {
  contactHeadroomForUser,
  contactUsageForUser,
  createContactForUser,
  createContactsBulkForUser,
} from "../src/lib/contact-writes";
import { createCompanyResolver } from "../src/lib/companies";
import { ensureUserSettings } from "../src/lib/user-settings";

const USER = "smoke-entitlements-user";
const WRITE_OPTS = { skipEmbedding: true, skipRevalidate: true } as const;

function check(label: string, condition: boolean, detail?: string) {
  if (!condition) throw new Error(`${label} failed${detail ? `: ${detail}` : ""}`);
  console.log(`  ok  ${label}`);
}

async function contactCount() {
  const db = await getDb();
  const [row] = await db
    .select({ value: count() })
    .from(contacts)
    .where(eq(contacts.userId, USER));
  return row?.value ?? 0;
}

async function setBilling(patch: Partial<typeof userSettings.$inferInsert>) {
  const db = await getDb();
  await db.update(userSettings).set(patch).where(eq(userSettings.userId, USER));
}

async function reset() {
  const db = await getDb();
  await db.delete(contacts).where(eq(contacts.userId, USER));
  await db.delete(userSettings).where(eq(userSettings.userId, USER));
  await ensureUserSettings(USER);
}

async function main() {
  console.log("Paywall smoke test (pglite)…");
  await reset();

  // --- pure resolution precedence (no DB) ---
  console.log("\nplan precedence");
  const future = new Date(Date.now() + 86400000);
  const past = new Date(Date.now() - 86400000);

  check("no row -> free", resolvePlan(null).plan === "free");
  check(
    "comp beats everything",
    resolvePlan({ compedPlan: "lifetime", subscriptionPlan: "orbit", subscriptionStatus: "active" }).source === "comp"
  );
  check(
    "lifetime beats subscription",
    resolvePlan({ lifetimePurchasedAt: past, subscriptionPlan: "orbit", subscriptionStatus: "active" }).plan === "lifetime"
  );
  check(
    "active subscription -> orbit",
    resolvePlan({ subscriptionPlan: "orbit", subscriptionStatus: "active" }).plan === "orbit"
  );
  check(
    "canceled but still paid -> orbit",
    resolvePlan({ subscriptionPlan: "orbit", subscriptionStatus: "canceled", subscriptionPeriodEnd: future }).plan === "orbit"
  );
  check(
    "canceled and lapsed -> free",
    resolvePlan({ subscriptionPlan: "orbit", subscriptionStatus: "canceled", subscriptionPeriodEnd: past }).plan === "free"
  );

  // --- free tier cap ---
  console.log("\nfree tier");
  let ent = await getEntitlements(USER);
  check("free plan resolved", ent.plan === "free", ent.plan);
  check(`contact limit is ${FREE_CONTACT_LIMIT}`, ent.contactLimit === FREE_CONTACT_LIMIT);
  check("outreach gated", ent.canUseOutreach === false);
  check("sync gated", ent.canUseSync === false);
  check("hosted sending gated", ent.canUseHostedSending === false);
  check("hosted enrichment gated", ent.canUseHostedEnrichment === false);

  const resolver = await createCompanyResolver(USER);
  const bulk = Array.from({ length: FREE_CONTACT_LIMIT - 1 }, (_, i) => ({
    fullName: `Bulk Person ${i + 1}`,
  }));
  const createdBulk = await createContactsBulkForUser(USER, bulk, resolver, WRITE_OPTS);
  check(
    `bulk created ${FREE_CONTACT_LIMIT - 1}`,
    createdBulk.length === FREE_CONTACT_LIMIT - 1,
    String(createdBulk.length)
  );

  check("headroom is 1", (await contactHeadroomForUser(USER)) === 1);

  const last = await createContactForUser(USER, { fullName: `Contact Number ${FREE_CONTACT_LIMIT}` }, WRITE_OPTS);
  check(`contact #${FREE_CONTACT_LIMIT} saved`, Boolean(last?.id));
  check(`count is ${FREE_CONTACT_LIMIT}`, (await contactCount()) === FREE_CONTACT_LIMIT);

  let threw: unknown = null;
  try {
    await createContactForUser(USER, { fullName: `Contact Number ${FREE_CONTACT_LIMIT + 1}` }, WRITE_OPTS);
  } catch (err) {
    threw = err;
  }
  check("contact #101 refused", isPaywallError(threw), String(threw));
  check(`still exactly ${FREE_CONTACT_LIMIT}`, (await contactCount()) === FREE_CONTACT_LIMIT);

  // --- never hide data ---
  console.log("\nover-cap access");
  const readDb = await getDb();
  const visible = await readDb
    .select({ id: contacts.id })
    .from(contacts)
    .where(eq(contacts.userId, USER));
  check(
    `all ${FREE_CONTACT_LIMIT} still readable at the cap`,
    visible.length === FREE_CONTACT_LIMIT,
    String(visible.length)
  );

  // --- bulk truncation ---
  console.log("\nbulk truncation");
  await setBilling({ compedPlan: null });
  const overflow = Array.from({ length: 50 }, (_, i) => ({ fullName: `Overflow ${i}` }));
  const none = await createContactsBulkForUser(USER, overflow, resolver, WRITE_OPTS);
  check("bulk at cap creates nothing", none.length === 0, String(none.length));

  // headroom of 3 admits exactly 3 of 50
  const db = await getDb();
  const doomed = await db
    .select({ id: contacts.id })
    .from(contacts)
    .where(and(eq(contacts.userId, USER)))
    .limit(3);
  for (const row of doomed) await db.delete(contacts).where(eq(contacts.id, row.id));
  const partial = await createContactsBulkForUser(USER, overflow, resolver, WRITE_OPTS);
  check("bulk admits exactly the headroom (3 of 50)", partial.length === 3, String(partial.length));

  // --- comped lifetime ---
  console.log("\ncomped lifetime");
  await setBilling({ compedPlan: "lifetime" });
  ent = await getEntitlements(USER);
  check("plan is lifetime", ent.plan === "lifetime", ent.plan);
  check("source is comp", ent.source === "comp", ent.source);
  check("contacts unlimited", ent.contactLimit === null);
  check("headroom unlimited", (await contactHeadroomForUser(USER)) === null);
  check("outreach unlocked", ent.canUseOutreach === true);
  check("sync unlocked", ent.canUseSync === true);
  check("extension unlocked", ent.canUseExtension === true);
  // The whole point of the split: Lifetime sends on Orbit's credits (bounded by
  // DAILY_SEND_LIMIT) but enriches on its own Apollo key (which has no ceiling).
  check("hosted sending unlocked on lifetime", ent.canUseHostedSending === true);
  check("hosted enrichment gated on lifetime", ent.canUseHostedEnrichment === false);

  const past101 = await createContactsBulkForUser(
    USER,
    Array.from({ length: 25 }, (_, i) => ({ fullName: `Beyond Cap ${i}` })),
    resolver,
    WRITE_OPTS
  );
  check("lifetime creates past the free cap", past101.length === 25, String(past101.length));

  // --- subscription grants hosted enrichment ---
  console.log("\norbit subscription");
  await setBilling({
    compedPlan: null,
    subscriptionPlan: "orbit",
    subscriptionStatus: "active",
    subscriptionPeriodEnd: future,
  });
  ent = await getEntitlements(USER);
  check("plan is orbit", ent.plan === "orbit", ent.plan);
  check("hosted sending unlocked", ent.canUseHostedSending === true);
  check("hosted enrichment unlocked", ent.canUseHostedEnrichment === true);

  // --- lifetime + live subscription are additive ---
  // `resolvePlan` ranks lifetime above subscription, so this user resolves to `lifetime`,
  // which is denied enrichment on its own. The union in `getEntitlements` is the only
  // thing that grants it back, and it is now the sole flag that union can affect.
  console.log("\nlifetime plus live subscription");
  await setBilling({
    lifetimePurchasedAt: past,
    subscriptionPlan: "orbit",
    subscriptionStatus: "active",
    subscriptionPeriodEnd: future,
  });
  ent = await getEntitlements(USER);
  check("plan stays lifetime", ent.plan === "lifetime", ent.plan);
  check("subscription unions enrichment back in", ent.canUseHostedEnrichment === true);

  // Lapse the subscription: the Lifetime floor holds, enrichment falls away.
  await setBilling({ subscriptionStatus: "canceled", subscriptionPeriodEnd: past });
  ent = await getEntitlements(USER);
  check("plan still lifetime after lapse", ent.plan === "lifetime", ent.plan);
  check("enrichment gated again after lapse", ent.canUseHostedEnrichment === false);
  check("sending survives the lapse", ent.canUseHostedSending === true);

  await setBilling({
    lifetimePurchasedAt: null,
    subscriptionPlan: "orbit",
    subscriptionStatus: "active",
    subscriptionPeriodEnd: future,
  });
  ent = await getEntitlements(USER);

  const usage = await contactUsageForUser(USER);
  check("usage reports unlimited", usage.limit === null, JSON.stringify(usage));

  // --- demo accounts are never gated ---
  // The showcase account stays on the plan it holds (free here) so the on-stage upgrade
  // still has something to upgrade from; only the gates lift.
  console.log("\ndemo accounts");
  await reset();
  const priorShowcase = process.env.DEMO_ACCOUNT_USER_ID;
  process.env.DEMO_ACCOUNT_USER_ID = USER;
  try {
    ent = await getEntitlements(USER);
    check("showcase keeps its real plan", ent.plan === "free" && ent.source === "free", ent.plan);
    check("showcase has no contact cap", ent.contactLimit === null);
    check("showcase headroom unlimited", (await contactHeadroomForUser(USER)) === null);
    check(
      "showcase has every feature",
      ent.canUseOutreach &&
        ent.canUseHostedSending &&
        ent.canUseHostedEnrichment &&
        ent.canUseRecruiters &&
        ent.canUseSync &&
        ent.canUseExtension &&
        ent.canUseApi,
      JSON.stringify(ent)
    );
    let demoThrew: unknown = null;
    try {
      await requireEntitlement(USER, "hostedEnrichment");
    } catch (err) {
      demoThrew = err;
    }
    check("requireEntitlement lets the showcase through", demoThrew === null, String(demoThrew));

    await setBilling({ compedPlan: "lifetime" });
    ent = await getEntitlements(USER);
    check("comped showcase reports lifetime", ent.plan === "lifetime", ent.plan);
    check("comped showcase keeps hosted enrichment", ent.canUseHostedEnrichment === true);
  } finally {
    if (priorShowcase === undefined) delete process.env.DEMO_ACCOUNT_USER_ID;
    else process.env.DEMO_ACCOUNT_USER_ID = priorShowcase;
  }
  check("another account is not the showcase", !isDemoAccount("someone-else"));
  // Localhost (`next dev`) makes every account a demo account, Clerk or not. Outside it,
  // `demo-user` gets nothing: a Clerk-less deploy would otherwise hand every anonymous
  // visitor paid access on that shared account.
  const env = process.env as Record<string, string | undefined>;
  const priorEnv = { node: env.NODE_ENV, clerk: env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY };
  try {
    delete env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY;
    env.NODE_ENV = "development";
    check("demo-user on localhost is a demo account", isDemoAccount("demo-user"));
    env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY = "pk_test_smoke";
    check("a Clerk account on localhost is a demo account", isDemoAccount("user_real"));
    ent = await getEntitlements(USER);
    check("localhost lifts every gate", ent.canUseOutreach && ent.contactLimit === null);
    env.NODE_ENV = "production";
    check("a Clerk account off localhost is not", !isDemoAccount("user_real"));
    delete env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY;
    check("demo-user in a Clerk-less prod build is not", !isDemoAccount("demo-user"));
    await setBilling({ compedPlan: null });
    ent = await getEntitlements(USER);
    check("off localhost the free gates hold", !ent.canUseOutreach && ent.contactLimit !== null);
  } finally {
    if (priorEnv.node === undefined) delete env.NODE_ENV;
    else env.NODE_ENV = priorEnv.node;
    if (priorEnv.clerk === undefined) delete env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY;
    else env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY = priorEnv.clerk;
  }

  await reset();
  const db2 = await getDb();
  await db2.delete(userSettings).where(eq(userSettings.userId, USER));
  console.log("\nAll paywall checks passed.");
}

main()
  .then(() => {
    // The pooled DB connection keeps the event loop alive; exit explicitly. Without this
    // the script hangs after printing its results as soon as anything in the code under
    // test performs an extra write — the same reason every sibling script does this.
    process.exit(0);
  })
  .catch((e) => {
    console.error("\nFAILED:", e);
    process.exit(1);
  });
