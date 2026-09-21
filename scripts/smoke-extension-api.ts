/**
 * The browser extension's API: contract v2, the free/Pro split, and the gate
 * recorder. The first smoke coverage `/api/extension/*` has ever had.
 *
 * Three layers, because one of them cannot be reached end to end:
 *
 *   1. The gate DECISION — `extensionFeatures(entitlements)` — is pure, and is
 *      what both `/me` (to draw a lock) and `extensionRoute` (to refuse) read.
 *      Tested per plan here, which is what makes "the panel shows it locked"
 *      and "the server refuses it" impossible to drift.
 *   2. The gate RECORDER — `recordExtensionGateHit` — against a real database:
 *      one row per user, per feature, per day, however often the panel asks.
 *   3. The ROUTES, driven as real handlers: auth, the envelope, /me v2, /gate.
 *
 * Why not a locked route end to end: the extension's dev-secret auth only works
 * under NODE_ENV=development, and in development every account is a demo
 * account with every feature unlocked (`isDemoAccount`). A route can therefore
 * only be observed ALLOWED from here. Rather than add an auth bypass to make
 * the refusal observable, the refusal is covered at layers 1 and 2, which are
 * exactly the two things the wrapper composes.
 *
 * Run: npx tsx scripts/smoke-extension-api.ts
 */
import "./smoke/_env";
import { run } from "./smoke/_env";
import { and, eq, sql } from "drizzle-orm";
import { getDb } from "../src/db";
import { gateEvents } from "../src/db/schema";
import { entitlementsForPlan } from "../src/lib/entitlements";
import {
  EXTENSION_FEATURES,
  extensionEntitlements,
  extensionFeatures,
  extensionUpgradeUrl,
  FEATURE_LOCKED_COPY,
} from "../src/lib/extension/entitlements";
import { recordExtensionGateHit } from "../src/lib/gate-events";

const SECRET = "smoke-extension-secret";
const USER = "smoke-ext-api-user";
const OTHER = "smoke-ext-api-other";

let failures = 0;
function check(label: string, ok: boolean, detail?: string) {
  if (ok) console.log(`  ok   ${label}`);
  else {
    console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ""}`);
    failures++;
  }
}

async function cleanup() {
  const db = await getDb();
  for (const user of [USER, OTHER]) {
    await db.delete(gateEvents).where(eq(gateEvents.userId, user));
  }
}

async function gateRows(userId: string) {
  const db = await getDb();
  return db
    .select({ context: gateEvents.context, feature: gateEvents.feature })
    .from(gateEvents)
    .where(and(eq(gateEvents.userId, userId), eq(gateEvents.feature, "extensionPro")));
}

function layerOne() {
  console.log("1. the gate decision, per plan");
  const free = extensionFeatures(entitlementsForPlan("free", "free"));
  const pro = extensionFeatures(entitlementsForPlan("orbit", "subscription"));
  const lifetime = extensionFeatures(entitlementsForPlan("lifetime", "lifetime"));
  check("free: every Pro feature locked", EXTENSION_FEATURES.every((f) => !free[f]), JSON.stringify(free));
  check("Pro: every feature open", EXTENSION_FEATURES.every((f) => pro[f]), JSON.stringify(pro));
  check("Lifetime: every feature open", EXTENSION_FEATURES.every((f) => lifetime[f]), JSON.stringify(lifetime));
  check(
    "the core stays free (canUseExtension)",
    entitlementsForPlan("free", "free").canUseExtension === true
  );

  const reported = extensionEntitlements(entitlementsForPlan("free", "free"), 90);
  check(
    "free headroom is the cap minus what's saved",
    reported.contactLimit !== null && reported.contactsRemaining === reported.contactLimit - 90,
    JSON.stringify(reported)
  );
  check(
    "headroom never goes negative",
    extensionEntitlements(entitlementsForPlan("free", "free"), 10_000).contactsRemaining === 0
  );
  check(
    "paid headroom is unlimited",
    extensionEntitlements(entitlementsForPlan("orbit", "subscription"), 10_000).contactsRemaining === null
  );

  const url = new URL(extensionUpgradeUrl("https://orbit.example", "workHistory"));
  check(
    "upgrade link says where it came from and why",
    url.pathname === "/pricing" &&
      url.searchParams.get("from") === "extension" &&
      url.searchParams.get("feature") === "workHistory",
    url.toString()
  );
  // A v1 panel shows `message` verbatim, so each one must stand alone.
  check(
    "every lock has copy that names the plans",
    EXTENSION_FEATURES.every((f) => /Orbit Pro and Lifetime/.test(FEATURE_LOCKED_COPY[f]))
  );
}

async function layerTwo() {
  console.log("2. the gate recorder: one row per user, per feature, per day");
  const first = await recordExtensionGateHit({ userId: USER, plan: "free", feature: "starters" });
  const second = await recordExtensionGateHit({ userId: USER, plan: "free", feature: "starters" });
  const third = await recordExtensionGateHit({ userId: USER, plan: "free", feature: "starters" });
  check("the first click is recorded", first === true);
  check("repeats the same day are not", second === false && third === false);
  check("…so three clicks leave one row", (await gateRows(USER)).length === 1);

  const other = await recordExtensionGateHit({ userId: USER, plan: "free", feature: "workHistory" });
  check("a different feature is its own signal", other === true && (await gateRows(USER)).length === 2);

  const someoneElse = await recordExtensionGateHit({ userId: OTHER, plan: "free", feature: "starters" });
  check("another user is their own signal", someoneElse === true);

  const rows = await gateRows(USER);
  check(
    "rows carry which sub-feature, for the demand screen",
    rows.every((r) => typeof (r.context as { feature?: unknown }).feature === "string"),
    JSON.stringify(rows)
  );

  const db = await getDb();
  await db.execute(
    sql`UPDATE gate_events SET created_at = now() - interval '25 hours' WHERE user_id = ${USER}`
  );
  const nextDay = await recordExtensionGateHit({ userId: USER, plan: "free", feature: "starters" });
  check("a day later, it counts again", nextDay === true);
}

async function layerThree() {
  console.log("3. the routes, as real handlers");
  // Dev-secret auth, and no Clerk: the only way a script can authenticate.
  delete process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY;
  delete process.env.CLERK_SECRET_KEY;
  (process.env as Record<string, string>).NODE_ENV = "development";
  process.env.EXTENSION_DEV_SECRET = SECRET;
  process.env.EXTENSION_DEV_USER_ID = USER;
  // Development also auto-seeds an empty account with a demo workspace, which
  // would leave 25 contacts in the suite's shared database for nothing.
  process.env.ORBIT_DEMO_DATA = "off";

  const { GET: me, OPTIONS: meOptions } = await import("../src/app/api/extension/me/route");
  const { POST: gate } = await import("../src/app/api/extension/gate/route");
  const { EXTENSION_CONTRACT_VERSION } = await import("../src/lib/extension/contract");

  const req = (path: string, init: { method?: string; body?: unknown; secret?: boolean } = {}) => {
    const headers = new Headers({ "content-type": "application/json" });
    if (init.secret !== false) headers.set("x-orbit-dev-secret", SECRET);
    return new Request(`https://orbit.test/api/extension${path}`, {
      method: init.method ?? (init.body ? "POST" : "GET"),
      headers,
      body: init.body ? JSON.stringify(init.body) : undefined,
    });
  };

  const unauth = await me(req("/me", { secret: false }));
  const unauthBody = await unauth.json();
  check(
    "no credentials → 401 in the JSON envelope, not a redirect",
    unauth.status === 401 && unauthBody.ok === false && unauthBody.error.code === "unauthorized",
    `${unauth.status} ${JSON.stringify(unauthBody)}`
  );

  const res = await me(req("/me"));
  const body = await res.json();
  const data = body.data;
  check("/me answers", res.status === 200 && body.ok === true, `${res.status} ${JSON.stringify(body)}`);
  check("contract version is 2", data?.contractVersion === 2 && EXTENSION_CONTRACT_VERSION === 2);
  check("it says the oldest build it still serves", data?.minSupportedContractVersion === 1);
  check(
    "entitlements carry every feature",
    EXTENSION_FEATURES.every((f) => typeof data?.entitlements?.features?.[f] === "boolean"),
    JSON.stringify(data?.entitlements)
  );
  check("…and a plan label for display", typeof data?.entitlements?.planLabel === "string");
  check(
    "links point at pricing, marked as from the extension",
    typeof data?.links?.pricing === "string" && data.links.pricing.includes("from=extension")
  );
  check(
    "v1 fields are all still there (old builds keep working)",
    typeof data?.user === "object" &&
      typeof data?.capabilities?.hasAiKey === "boolean" &&
      typeof data?.stats?.contactCount === "number"
  );

  await cleanup();
  const clicked = await gate(req("/gate", { body: { feature: "company", site: "linkedin" } }));
  const clickedBody = await clicked.json();
  check(
    "/gate records a click and hands back the upgrade link",
    clicked.status === 200 &&
      clickedBody.data?.recorded === true &&
      clickedBody.data?.upgradeUrl?.includes("feature=company"),
    JSON.stringify(clickedBody)
  );
  const again = await (await gate(req("/gate", { body: { feature: "company" } }))).json();
  check("a second click the same day is not recorded again", again.data?.recorded === false);

  const bad = await gate(req("/gate", { body: { feature: "everything" } }));
  const badBody = await bad.json();
  check(
    "an unknown feature is a 400 with the field named",
    bad.status === 400 && badBody.error?.code === "invalid_request" && /feature/.test(badBody.error?.message),
    JSON.stringify(badBody)
  );

  const preflight = await meOptions();
  check("a stray preflight gets a clean 204", preflight.status === 204);
}

run(async () => {
  await cleanup();
  layerOne();
  await layerTwo();
  await layerThree();
  await cleanup();
  if (failures) {
    console.error(`\nsmoke-extension-api: ${failures} check(s) failed`);
    process.exit(1);
  }
  console.log("\nsmoke-extension-api: all checks passed");
});
