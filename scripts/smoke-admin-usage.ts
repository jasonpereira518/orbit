/**
 * /admin/billing/usage (`src/lib/admin-usage.ts`):
 *
 *  - credits: used + remaining = granted, read from the account's current allowance grant;
 *    a grant from a past cycle is not this period's;
 *  - speech and contacts land on the account's row against its plan's limit;
 *  - an operator override of a plan limit is honoured (pure: no global plan rule is written,
 *    since smokes can run against the shared database);
 *  - the fullest account sorts first, and a zero cap with use reads as over.
 *
 * Run: npx tsx scripts/smoke-admin-usage.ts
 */
import "./smoke/_env";
import { run } from "./smoke/_env";

let failures = 0;
function check(label: string, ok: boolean, detail?: unknown) {
  if (ok) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.error(`  FAIL ${label}${detail === undefined ? "" : `\n       ${JSON.stringify(detail)}`}`);
  }
}

const P = "smoke-au-";
const PRO = `${P}pro`;
const FREE = `${P}free`;

run(async () => {
  const { inArray, like } = await import("drizzle-orm");
  const { getDb } = await import("../src/db");
  const schema = await import("../src/db/schema");
  const { accountUsage, loadAdminUsage } = await import("../src/lib/admin-usage");
  const { PLAN_CONFIG } = await import("../src/lib/plans/plan-config");
  const { applyPlanOverrides } = await import("../src/lib/plans/plan-overrides");
  const { MICROS_PER_CREDIT } = await import("../src/lib/credits/grants");

  const db = await getDb();
  const users = [PRO, FREE];
  const reset = async () => {
    await db.delete(schema.creditGrants).where(like(schema.creditGrants.grantKey, `${P}%`));
    await db.delete(schema.speechUsage).where(inArray(schema.speechUsage.userId, users));
    await db.delete(schema.contacts).where(inArray(schema.contacts.userId, users));
    await db.delete(schema.userSettings).where(inArray(schema.userSettings.userId, users));
  };
  await reset();

  const now = new Date();
  const day = 86_400_000;
  const periodEnd = new Date(now.getTime() + 20 * day);
  await db.insert(schema.userSettings).values([
    { userId: PRO, subscriptionPlan: "orbit", subscriptionStatus: "active", subscriptionPeriodEnd: periodEnd },
    { userId: FREE },
  ]);
  const grant = (key: string, granted: number, remaining: number, start: Date, end: Date) => ({
    userId: PRO, kind: "allowance" as const, grantKey: `${P}${key}`, plan: "orbit" as const,
    microsGranted: granted * MICROS_PER_CREDIT, microsRemaining: remaining * MICROS_PER_CREDIT,
    periodStart: start, periodEnd: end,
  });
  await db.insert(schema.creditGrants).values([
    grant("now", 300, 120, new Date(now.getTime() - 10 * day), periodEnd),
    grant("old", 300, 0, new Date(now.getTime() - 50 * day), new Date(now.getTime() - 20 * day)),
  ]);
  await db.insert(schema.speechUsage).values([
    { userId: FREE, kind: "shortform", seconds: 600, source: "file" },
    { userId: FREE, kind: "shortform", seconds: 300, source: "file" },
  ]);
  await db.insert(schema.contacts).values([
    { userId: FREE, fullName: "Smoke Usage One" },
    { userId: FREE, fullName: "Smoke Usage Two" },
  ]);

  console.log("This period, from the database");
  const { rows } = await loadAdminUsage(now);
  const pro = rows.find((r) => r.userId === PRO);
  const free = rows.find((r) => r.userId === FREE);
  check("Pro resolves to the orbit plan", pro?.plan === "orbit", pro?.plan);
  const c = pro?.meters.credits;
  check("credits: 180 used of the current 300-credit grant; the past cycle is ignored",
    c?.used === 180 && c?.limit === 300, c);
  check("credits: used + remaining = granted", !!c && c.used + 120 === c.limit, c);
  check("Free short-form: 900 s against the Free limit",
    free?.meters.shortform.used === 900 && free?.meters.shortform.limit === PLAN_CONFIG.free.speech.shortformSeconds,
    free?.meters.shortform);
  check("Free contacts: 2 against the Free cap",
    free?.meters.contacts.used === 2 && free?.meters.contacts.limit === PLAN_CONFIG.free.contactLimit, free?.meters.contacts);

  console.log("\nLimits and order (pure)");
  const empty = { credits: new Map(), meeting: new Map(), shortform: new Map(), enrichment: new Map(), contacts: new Map() };
  const readings = { ...empty, contacts: new Map([["a", 4], ["b", 1]]), enrichment: new Map([["c", 1]]) };
  const accounts = [
    { userId: "b", plan: "orbit" as const },
    { userId: "a", plan: "orbit" as const },
    { userId: "c", plan: "free" as const },
  ];
  const config = applyPlanOverrides(PLAN_CONFIG, { features: {}, limits: { orbit: { contactLimit: 5 } } });
  const out = accountUsage(accounts, readings, config);
  const a = out.find((r) => r.userId === "a");
  check("an override contact limit (5) replaces Pro's code default", a?.meters.contacts.limit === 5, a?.meters.contacts);
  check("…and 4 of 5 is an 80% peak", a?.peak === 0.8, a?.peak);
  check("enrichment against a zero cap reads as over, and sorts first", out[0]?.userId === "c" && out[0].peak === Infinity,
    out.map((r) => [r.userId, r.peak]));
  check("then the fuller Pro account", out[1]?.userId === "a" && out[2]?.userId === "b", out.map((r) => r.userId));
  const plain = accountUsage(accounts, readings, PLAN_CONFIG).find((r) => r.userId === "a");
  check("without the override Pro's contacts are uncapped", plain?.meters.contacts.limit === PLAN_CONFIG.orbit.contactLimit,
    plain?.meters.contacts);

  await reset();
  if (failures > 0) throw new Error(`${failures} admin-usage check(s) failed`);
  console.log("\nAll admin-usage checks passed.");
});
