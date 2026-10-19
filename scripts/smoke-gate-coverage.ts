/**
 * Gate coverage (audit D1, ANALYTICS_PLAN 2.5): the pricing-v2 walls that used to leave no row
 * (out of managed credits, the background floor, the Deepgram allowances) are recorded as
 * `gate_events` with a surface and route, throttled, and recording NEVER changes what the
 * caller does or says. `requireEntitlement` fills `context` when the caller can name it.
 *
 * The AI-gate and meeting-cap refusals themselves are driven in `smoke-ai-access.ts` and
 * `smoke-meeting-sessions.ts`, which assert the rows next to the refusal they belong to.
 *
 * Run: npx tsx scripts/smoke-gate-coverage.ts
 */
import "./smoke/_env";

import { readFileSync } from "node:fs";
import { and, eq } from "drizzle-orm";
import { getDb } from "../src/db";
import { gateEvents, userSettings } from "../src/db/schema";
import { FEATURE_DENIAL, isPaywallError, requireEntitlement } from "../src/lib/entitlements";
import { RECENT_GATE_WINDOW_MS, isKnownGate, mostRecentGate, recordGateHit, unlockPlanForGate } from "../src/lib/gate-events";
import { recordGateRefusal } from "../src/lib/gate-refusal";
import { GATES } from "../src/lib/product-event-schemas";
import { ensureUserSettings } from "../src/lib/user-settings";
import { unlockPlanFor } from "../src/lib/plans/plan-config";

const FREE = "smoke-gate-coverage-free";
const PRO = "smoke-gate-coverage-pro";

let failures = 0;
function check(label: string, ok: boolean, detail?: unknown) {
  if (ok) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.error(`  FAIL ${label}${detail === undefined ? "" : `\n       ${JSON.stringify(detail)}`}`);
  }
}

/** jsonb returns keys in its own order. */
const same = (a: unknown, b: unknown) => {
  const norm = (v: unknown): unknown =>
    v && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(
          Object.entries(v as Record<string, unknown>)
            .sort(([x], [y]) => x.localeCompare(y))
            .map(([k, x]) => [k, norm(x)])
        )
      : v;
  return JSON.stringify(norm(a)) === JSON.stringify(norm(b));
};

async function rowsFor(userId: string, feature?: string) {
  const db = await getDb();
  return db
    .select()
    .from(gateEvents)
    .where(feature ? and(eq(gateEvents.userId, userId), eq(gateEvents.feature, feature)) : eq(gateEvents.userId, userId));
}

async function main() {
  const db = await getDb();
  for (const u of [FREE, PRO]) {
    await db.delete(gateEvents).where(eq(gateEvents.userId, u));
    await db.delete(userSettings).where(eq(userSettings.userId, u));
    await ensureUserSettings(u);
  }
  await db.update(userSettings).set({ subscriptionStatus: "active", subscriptionPlan: "orbit" }).where(eq(userSettings.userId, PRO));

  console.log("The unlock plan of a metered wall");
  check("a plan feature keeps its answer (outreach unlocks on Pro)", unlockPlanForGate("outreach", "free") === unlockPlanFor("outreach"));
  check("the contact cap is unchanged (Pro)", unlockPlanForGate("contacts", "free") === "orbit");
  for (const feature of ["managedCredits", "backgroundFloor", "speechShortform", "speechMeeting"] as const) {
    check(
      `${feature}: Free is unlocked by Pro, Pro by Max, and Max by no plan (a pack)`,
      unlockPlanForGate(feature, "free") === "orbit" &&
        unlockPlanForGate(feature, "orbit") === "max" &&
        unlockPlanForGate(feature, "max") === null &&
        unlockPlanForGate(feature, "lifetime") === null
    );
  }
  await recordGateHit({ userId: FREE, feature: "managedCredits", plan: "free", context: { surface: "web", route: "chat.answer" } });
  const stored = (await rowsFor(FREE, "managedCredits"))[0];
  check("a recorded metered hit stores the plan above the one they were on", stored?.unlockPlan === "orbit" && stored.plan === "free", stored);
  check("…and the surface and route it was hit at", same(stored?.context, { surface: "web", route: "chat.answer" }), stored?.context);

  console.log("\nrecordGateRefusal: throttled, quiet, one row per account, wall and hour");
  await recordGateRefusal(FREE, "speechShortform", { surface: "web", route: "/api/speech/token" });
  await recordGateRefusal(FREE, "speechShortform", { surface: "web", route: "/api/speech/token" });
  await recordGateRefusal(FREE, "speechShortform", { surface: "web", route: "/api/speech/token" });
  check("a mic that retries three times is one row", (await rowsFor(FREE, "speechShortform")).length === 1);
  check("…whose plan is the account's own (resolved, not passed)", (await rowsFor(FREE, "speechShortform"))[0]?.plan === "free");
  await recordGateRefusal(FREE, "speechMeeting", { surface: "web", route: "/api/capture/meetings/[id]/stream-token" });
  check("a different wall is its own row", (await rowsFor(FREE, "speechMeeting")).length === 1 && (await rowsFor(FREE)).length === 3);
  await recordGateRefusal(PRO, "speechMeeting", { surface: "web", route: "meeting.chunk" });
  const proRow = (await rowsFor(PRO, "speechMeeting"))[0];
  check("another account is its own row, on its own plan", proRow?.plan === "orbit" && proRow.unlockPlan === "max", proRow);
  await recordGateRefusal(FREE, "speechShortform", { surface: "web", route: "x" }, { throttled: false });
  check("unthrottled records every time", (await rowsFor(FREE, "speechShortform")).length === 2);
  let threw = false;
  try {
    await recordGateRefusal("", "managedCredits", { surface: "web", route: "x" }, { plan: "free" });
  } catch {
    threw = true;
  }
  check("recording never throws", !threw);

  console.log("\nrequireEntitlement fills the context, and says exactly what it said");
  let refusal: unknown = null;
  try {
    await requireEntitlement(FREE, "api");
  } catch (err) {
    refusal = err;
  }
  check("a Free account is refused the API, with the same words", isPaywallError(refusal) && (refusal as Error).message === FEATURE_DENIAL.api, String(refusal));
  const noWhere = (await rowsFor(FREE, "api"))[0];
  check("without a caller-supplied place, the context says it was the web", same(noWhere?.context, { surface: "web" }), noWhere?.context);
  let refusal2: unknown = null;
  try {
    await requireEntitlement(FREE, "api", { surface: "api", route: "action.api-keys.create" });
  } catch (err) {
    refusal2 = err;
  }
  check("…the same refusal with a place", isPaywallError(refusal2) && (refusal2 as Error).message === FEATURE_DENIAL.api);
  const apiRows = await rowsFor(FREE, "api");
  check(
    "…which is recorded with its surface and route",
    apiRows.some((r) => same(r.context, { surface: "api", route: "action.api-keys.create" })),
    apiRows.map((r) => r.context)
  );

  console.log("\nThe gate attribution a checkout reads");
  await db.delete(gateEvents).where(eq(gateEvents.userId, FREE));
  check("no gate rows, no attribution", (await mostRecentGate(FREE)) === null);
  await db.insert(gateEvents).values({ userId: FREE, feature: "api", plan: "free", createdAt: new Date(Date.now() - 3 * 3_600_000) });
  await db.insert(gateEvents).values({ userId: FREE, feature: "managedCredits", plan: "free", createdAt: new Date(Date.now() - 3_600_000) });
  check("the most recent gate wins", (await mostRecentGate(FREE)) === "managedCredits");
  await db.insert(gateEvents).values({ userId: FREE, feature: "hostedAi", plan: "free", createdAt: new Date() });
  check("a feature outside the closed list is never attributed", (await mostRecentGate(FREE)) === null && !isKnownGate("hostedAi"));
  await db.delete(gateEvents).where(eq(gateEvents.userId, FREE));
  await db.insert(gateEvents).values({ userId: FREE, feature: "api", plan: "free", createdAt: new Date(Date.now() - RECENT_GATE_WINDOW_MS - 60_000) });
  check("a wall hit more than a day ago is not what sent them", (await mostRecentGate(FREE)) === null);

  const demandPage = readFileSync("src/app/(clerk)/(admin)/admin/billing/demand/page.tsx", "utf8");
  const unlabelled = GATES.filter((g) => !new RegExp(`\\b${g}:`).test(demandPage));
  check("every gate key a checkout can be attributed to has a label on the Demand page", unlabelled.length === 0, unlabelled);

  for (const u of [FREE, PRO]) {
    await db.delete(gateEvents).where(eq(gateEvents.userId, u));
    await db.delete(userSettings).where(eq(userSettings.userId, u));
  }
  if (failures > 0) {
    console.error(`\n${failures} check(s) failed`);
    process.exit(1);
  }
  console.log("\ngate coverage: all checks passed");
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  }
);
