/**
 * Runtime plan rules (/admin/product/plans): the row format, the effective plan table every
 * gate reads, widening and narrowing a feature, limit overrides, reset, junk rows, the
 * admin/demo exemptions, and a page tier lock closing the shared contact write path with a
 * `page` gate_events row.
 *
 * PGlite only (`./smoke/_env` drops DATABASE_URL). `app_surface_flags` is global, so every row
 * this writes is removed in `finally` and the table is checked back to its starting state.
 *
 * Run: npx tsx scripts/smoke-plan-rules.ts
 */
import "./smoke/_env";

import { and, eq, inArray } from "drizzle-orm";
import { getDb } from "../src/db";
import { appSurfaceFlags, contacts, gateEvents, userSettings } from "../src/db/schema";
import { contactHeadroomForUser, createContactForUser } from "../src/lib/contact-writes";
import { featureDenial, getEntitlements, isPaywallError, requireEntitlement } from "../src/lib/entitlements";
import { PLAN_CONFIG, PLANS } from "../src/lib/plans/plan-config";
import {
  applyPlanOverrides,
  featureRuleRow,
  limitRuleRow,
  parsePlanRules,
  plansWithFeature,
} from "../src/lib/plans/plan-overrides";
import {
  getEffectivePlanConfig,
  invalidateAppFlagRows,
  resetPlanRule,
  setFeaturePlans,
  setPlanLimit,
} from "../src/lib/plans/plan-rules";
import { speechAllowance } from "../src/lib/speech-quota";
import { requirePlanForSurface, setSurfaceTiers } from "../src/lib/surface-visibility";
import { readFileSync } from "node:fs";
import { callsIn } from "./smoke-connect-gates";
import { checker } from "./smoke/check";

const t = checker();
const ADMIN = "smoke-plan-rules-admin";
const FREE = "smoke-plan-rules-free";
const NEW_FREE = "smoke-plan-rules-new"; // never finished onboarding
const PRO = "smoke-plan-rules-pro";
const DEMO = "smoke-plan-rules-demo";
const USERS = [ADMIN, FREE, NEW_FREE, PRO, DEMO];
const WRITE_OPTS = { skipEmbedding: true, skipRevalidate: true } as const;

async function refused(fn: () => Promise<unknown>) {
  try {
    await fn();
    return null;
  } catch (err) {
    return err;
  }
}

function pure() {
  console.log("\nrow format");
  const rows = [
    featureRuleRow("recruiters", ["lifetime", "free"]),
    featureRuleRow("api", []),
    limitRuleRow("free", "contactLimit", null),
    limitRuleRow("orbit", "speech.meetingSeconds", 120),
  ];
  t.check("feature rows list plans cheapest first", rows[0] === "tiers:feature:recruiters:free,lifetime", rows[0]);
  t.check("an empty plan list is stored as '-'", rows[1] === "tiers:feature:api:-", rows[1]);
  t.check("unlimited is spelled out", rows[2] === "limit:free:contactLimit:unlimited", rows[2]);
  const rules = parsePlanRules([
    ...rows,
    "tiers:feature:bogus:free", // unknown feature
    "tiers:feature:sync:free,gold", // unknown plan
    "limit:gold:contactLimit:3", // unknown plan
    "limit:free:height:3", // unknown field
    "limit:free:monthlyCredits:-5", // negative
    "limit:free:monthlyCredits:1.5", // not an integer
    "limit:free:monthlyCredits:unlimited", // not nullable
    "limit:free:googleMicrosoftConnections:0", // below its minimum
    "tiers:page.radar:max", // a page rule, not a plan rule
    "page.radar",
  ]);
  t.check(
    "round trip: encoded rules parse back",
    rules.features.recruiters?.join() === "free,lifetime" &&
      rules.features.api?.length === 0 &&
      rules.limits.free?.contactLimit === null &&
      rules.limits.orbit?.["speech.meetingSeconds"] === 120,
    JSON.stringify(rules)
  );
  t.check(
    "junk rows are dropped",
    Object.keys(rules.features).sort().join() === "api,recruiters" &&
      Object.keys(rules.limits).sort().join() === "free,orbit" &&
      Object.keys(rules.limits.free ?? {}).join() === "contactLimit",
    JSON.stringify(rules)
  );

  const config = applyPlanOverrides(PLAN_CONFIG, rules);
  t.check("widening gives Free the feature", config.free.features.recruiters && !config.orbit.features.recruiters);
  t.check("narrowing to nobody takes it from every plan", PLANS.every((p) => !config[p].features.api));
  t.check("limits apply per plan", config.free.contactLimit === null && config.orbit.speech.meetingSeconds === 120);
  t.check("the code table is never mutated", PLAN_CONFIG.free.contactLimit === 500 && PLAN_CONFIG.max.features.api);
  t.check("no rules = the code table", JSON.stringify(applyPlanOverrides(PLAN_CONFIG, parsePlanRules([]))) === JSON.stringify(PLAN_CONFIG));

  const linked = applyPlanOverrides(PLAN_CONFIG, parsePlanRules([limitRuleRow("free", "googleMicrosoftConnections", 2)]));
  t.check("a second-connection limit turns on extraConnections", linked.free.features.extraConnections);
  const linked2 = applyPlanOverrides(PLAN_CONFIG, parsePlanRules([featureRuleRow("extraConnections", ["max"])]));
  t.check("…and the feature moves the limit", linked2.orbit.googleMicrosoftConnections === 1 && linked2.max.googleMicrosoftConnections === null);

  t.check(
    "a denial names the plans of the table it is given",
    /available on the Free Plan\./.test(featureDenial("recruiters", config)) && /Pro and Orbit Max/.test(featureDenial("recruiters")),
    featureDenial("recruiters", config)
  );
  t.check("the five unreleased features default to the paid plans", (["radar", "events", "findPeople", "compose", "cloudNotes"] as const).every(
    (f) => plansWithFeature(PLAN_CONFIG, f).join() === "orbit,max,lifetime"
  ));
}

async function main() {
  pure();

  const db = await getDb();
  const before = (await db.select({ k: appSurfaceFlags.surfaceKey }).from(appSurfaceFlags)).map((r) => r.k).sort();
  const priorAdmins = process.env.ADMIN_USER_IDS;
  const priorClerk = process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY;
  const priorShowcase = process.env.DEMO_ACCOUNT_USER_ID;
  process.env.ADMIN_USER_IDS = ADMIN;
  process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY ||= "pk_test_smoke";
  process.env.DEMO_ACCOUNT_USER_ID = DEMO;

  await db.delete(userSettings).where(inArray(userSettings.userId, USERS));
  const onboarded = new Date();
  await db.insert(userSettings).values([
    { userId: ADMIN, onboardingCompletedAt: onboarded },
    { userId: FREE, onboardingCompletedAt: onboarded },
    { userId: NEW_FREE },
    { userId: PRO, compedPlan: "orbit", onboardingCompletedAt: onboarded },
    { userId: DEMO, onboardingCompletedAt: onboarded },
  ]);

  try {
    console.log("\nfeatures");
    t.check("Free is refused recruiters by default", isPaywallError(await refused(() => requireEntitlement(FREE, "recruiters"))));
    await setFeaturePlans(ADMIN, "recruiters", PLANS);
    t.check("widen: recruiters → every plan lets Free through", (await refused(() => requireEntitlement(FREE, "recruiters"))) === null);

    await setFeaturePlans(ADMIN, "recruiters", ["max", "lifetime"]);
    const narrowed = await refused(() => requireEntitlement(PRO, "recruiters", { route: "smoke" }));
    t.check("narrow: recruiters → Max and Lifetime refuses Pro", isPaywallError(narrowed));
    t.check("…with a denial that follows the rule", narrowed instanceof Error && /available on Orbit Max\./.test(narrowed.message), String(narrowed));
    const [hit] = await db.select().from(gateEvents).where(and(eq(gateEvents.userId, PRO), eq(gateEvents.feature, "recruiters")));
    t.check("…and a gate row whose unlock plan is the effective one", hit?.unlockPlan === "max", hit?.unlockPlan ?? "no row");

    await setFeaturePlans(ADMIN, "recruiters", []);
    t.check("a demo account stays exempt from plan rules", (await refused(() => requireEntitlement(DEMO, "recruiters"))) === null);

    await resetPlanRule(ADMIN, { kind: "feature", feature: "recruiters" });
    t.check(
      "reset deletes the rule and restores the default",
      !(await db.select().from(appSurfaceFlags)).some((r) => r.surfaceKey.startsWith("tiers:feature:recruiters")) &&
        (await refused(() => requireEntitlement(PRO, "recruiters"))) === null
    );
    await setFeaturePlans(ADMIN, "recruiters", plansWithFeature(PLAN_CONFIG, "recruiters"));
    t.check("saving the default writes no row", !(await db.select().from(appSurfaceFlags)).some((r) => r.surfaceKey.startsWith("tiers:feature:")));

    console.log("\nlimits");
    await setPlanLimit(ADMIN, "free", "contactLimit", 2);
    t.check("the contact cap follows the override", (await getEntitlements(FREE)).contactLimit === 2);
    t.check("…and so does headroom", (await contactHeadroomForUser(FREE)) === 2);
    await setPlanLimit(ADMIN, "free", "speech.shortformSeconds", 60);
    t.check("speech seconds follow the override", (await speechAllowance(FREE, "shortform")).limit === 60);
    t.check(
      "negative and unlimited-on-a-counted-field limits are refused",
      (await refused(() => setPlanLimit(ADMIN, "free", "contactLimit", -1))) instanceof Error &&
        (await refused(() => setPlanLimit(ADMIN, "free", "monthlyCredits", null))) instanceof Error
    );
    await resetPlanRule(ADMIN, { kind: "limit", plan: "free", field: "contactLimit" });
    await resetPlanRule(ADMIN, { kind: "limit", plan: "free", field: "speech.shortformSeconds" });
    t.check("reset restores the defaults", (await getEntitlements(FREE)).contactLimit === PLAN_CONFIG.free.contactLimit &&
      (await speechAllowance(FREE, "shortform")).limit === PLAN_CONFIG.free.speech.shortformSeconds);

    console.log("\njunk rows");
    await db.insert(appSurfaceFlags).values(
      ["limit:free:contactLimit:-5", "tiers:feature:bogus:free", "limit:gold:contactLimit:3"].map((surfaceKey) => ({ surfaceKey, hiddenBy: ADMIN }))
    );
    invalidateAppFlagRows();
    t.check("unknown or invalid rows change nothing", JSON.stringify(await getEffectivePlanConfig()) === JSON.stringify(PLAN_CONFIG));

    console.log("\npage lock on the shared contact write path");
    await setSurfaceTiers(ADMIN, "page.contacts", ["max", "lifetime"]);
    const pageRefusal = await refused(() => createContactForUser(FREE, { fullName: "Locked Out" }, WRITE_OPTS));
    t.check("a Contacts tier lock refuses a Free contact create", isPaywallError(pageRefusal) && pageRefusal.feature === "page", String(pageRefusal));
    const [pageHit] = await db.select().from(gateEvents).where(and(eq(gateEvents.userId, FREE), eq(gateEvents.feature, "page")));
    t.check("…recorded as a page gate hit, unlocking on Max", pageHit?.unlockPlan === "max", JSON.stringify(pageHit?.context));
    t.check("…and imports/sync see no headroom", (await contactHeadroomForUser(FREE)) === 0);
    t.check("an admin is exempt from the lock", (await refused(() => requirePlanForSurface(ADMIN, "page.contacts"))) === null);
    t.check("a demo account is exempt from the lock", (await refused(() => requirePlanForSurface(DEMO, "page.contacts"))) === null);
    t.check(
      "an account still in onboarding is exempt (quick setup creates contacts)",
      (await refused(() => createContactForUser(NEW_FREE, { fullName: "First Run" }, WRITE_OPTS))) === null
    );
  } finally {
    await db.delete(appSurfaceFlags).where(eq(appSurfaceFlags.hiddenBy, ADMIN));
    invalidateAppFlagRows();
    await db.delete(contacts).where(inArray(contacts.userId, USERS));
    await db.delete(gateEvents).where(inArray(gateEvents.userId, USERS));
    await db.delete(userSettings).where(inArray(userSettings.userId, USERS));
    if (priorAdmins === undefined) delete process.env.ADMIN_USER_IDS;
    else process.env.ADMIN_USER_IDS = priorAdmins;
    if (priorClerk === undefined) delete process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY;
    else process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY = priorClerk;
    if (priorShowcase === undefined) delete process.env.DEMO_ACCOUNT_USER_ID;
    else process.env.DEMO_ACCOUNT_USER_ID = priorShowcase;
  }
  const after = (await db.select({ k: appSurfaceFlags.surfaceKey }).from(appSurfaceFlags)).map((r) => r.k).sort();
  t.check("app_surface_flags restored to its pre-run state", after.join() === before.join());
  console.log("\npage actions apply the tier lock");
  const guarded: Array<[string, string[]]> = [
    ["src/actions/contacts.ts", ["createContactDetailed", "updateContact", "logInteraction"]],
    ["src/actions/imports.ts", ["startLinkedInImport", "confirmGoogleContactsImport"]],
    ["src/actions/reminders.ts", ["createReminder", "scheduleContactFollowUp"]],
    ["src/actions/capture.ts", ["parseBulkCaptureNotes", "confirmBulkCapture"]],
  ];
  for (const [file, fns] of guarded) {
    for (const fn of fns) t.check(`${fn} calls requirePageUser`, callsIn(file, fn).has("requirePageUser"));
  }
  t.check("the bell and dashboard reads stay open", !callsIn("src/actions/reminders.ts", "fetchDashboard").has("requirePageUser"));
  t.check("recording meetings checks the Meetings page", /requireVisibleSurface\(userId, "page\.meetings"\)/.test(readFileSync("src/lib/plan-guards.ts", "utf8")));
  t.done("plan rules");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
