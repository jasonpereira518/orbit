/**
 * The live layer: what each screen refetches, and the shape it is allowed to be.
 *
 * THE STRUCTURAL RULE THIS ENFORCES. A live update may replace text inside a node that
 * already exists; it may not add, remove or reorder one. Nothing may move while the
 * operator is reading it. That rule lives or dies on the payload being FLAT SCALARS — the
 * moment an endpoint returns an array, somebody will render it, and the console starts
 * reflowing under the cursor on a timer. So every value is asserted to be a scalar.
 *
 * THE SECOND is the gate. `(admin)/layout.tsx` does not run for route handlers, so each
 * one under `/api/admin` gates itself, and an unknown screen name has to be
 * indistinguishable from a wrong guess at the path — both 404, neither says why.
 *
 * THE THIRD is that a withheld ratio stays withheld. `engagementDepth` returns null for
 * stickiness below its floor; if a live poll turned that null into a number, the console
 * would quietly start publishing a figure it spent effort refusing to compute.
 *
 * Run: npx tsx scripts/smoke-admin-live.ts
 */
import { config } from "dotenv";
config({ path: ".env.local" });
config();

import { inArray } from "drizzle-orm";
import { getDb } from "../src/db";
import { userSettings } from "../src/db/schema";
import { ensureUserSettings } from "../src/lib/user-settings";
import { liveValues } from "../src/lib/admin-live";
import {
  LIVE_TIERS,
  SCREEN_TIER,
  isLiveScreen,
  type LiveScreen,
} from "../src/lib/admin-live-tiers";

const PREFIX = "smoke-live-";
const ALL = [`${PREFIX}a`, `${PREFIX}b`];

const SCREENS: LiveScreen[] = ["overview", "health", "funnel", "billing", "product"];

/** What each screen's page actually renders through `LiveValue`. */
const EXPECTED_KEYS: Record<LiveScreen, string[]> = {
  overview: ["totalUsers", "paid", "subscribed", "comped", "lifetimeSold", "systemIssues"],
  health: ["systemIssues"],
  funnel: ["dau", "wau", "mau", "liveNow", "stickiness"],
  billing: ["mrr", "ledger", "drift"],
  product: ["atCap", "nearCap"],
};

function check(label: string, condition: boolean, detail?: string) {
  if (!condition) throw new Error(`${label} failed${detail ? `: ${detail}` : ""}`);
  console.log(`  ok  ${label}`);
}

async function cleanup() {
  const db = await getDb();
  await db.delete(userSettings).where(inArray(userSettings.userId, ALL));
}

async function main() {
  await cleanup();
  for (const id of ALL) await ensureUserSettings(id);

  /* ------------------------------------------------------------------ the payloads */

  for (const screen of SCREENS) {
    const values = await liveValues(screen);

    check(
      `${screen}: publishes every key its page binds`,
      EXPECTED_KEYS[screen].every((k) => k in values),
      `missing ${EXPECTED_KEYS[screen].filter((k) => !(k in values)).join(", ")}`
    );

    // THE RULE. Anything non-scalar here is a list waiting to be rendered on a timer.
    const nonScalar = Object.entries(values).filter(
      ([, v]) => v !== null && typeof v !== "number" && typeof v !== "string"
    );
    check(
      `${screen}: every value is a scalar, so nothing can reflow`,
      nonScalar.length === 0,
      nonScalar.map(([k]) => k).join(", ")
    );
  }

  /* -------------------------------------------------------------- withheld ratios */

  const funnel = await liveValues("funnel");
  const { STICKINESS_MINIMUM_MAU } = await import("../src/lib/admin-funnel");
  const mau = Number(funnel.mau ?? 0);
  check(
    `stickiness stays withheld below ${STICKINESS_MINIMUM_MAU} monthly actives`,
    mau >= STICKINESS_MINIMUM_MAU || funnel.stickiness === null,
    `mau ${mau}, stickiness ${funnel.stickiness}`
  );

  /* -------------------------------------------------------------------- the tiers */

  check(
    "expensive screens poll less often than cheap ones",
    SCREEN_TIER.billing > SCREEN_TIER.overview &&
      SCREEN_TIER.product > SCREEN_TIER.overview,
    JSON.stringify(SCREEN_TIER)
  );
  check(
    "presence stays the fastest tier",
    LIVE_TIERS.presence < LIVE_TIERS.counters &&
      LIVE_TIERS.counters < LIVE_TIERS.aggregates
  );
  check("every screen declares a cadence", SCREENS.every((s) => SCREEN_TIER[s] > 0));

  /* --------------------------------------------------------------------- the gate */

  check("a known screen name is recognised", SCREENS.every(isLiveScreen));
  check(
    "an unknown one is not",
    !isLiveScreen("users") && !isLiveScreen("../../etc/passwd") && !isLiveScreen("")
  );

  const { GET } = await import("../src/app/api/admin/live/[screen]/route");

  // No Clerk keys locally, so `requireAdminUserId` throws and the handler must 404 —
  // never 403, which would confirm the endpoint exists to whoever found the path.
  const unauth = await GET(new Request("http://localhost/api/admin/live/overview"), {
    params: Promise.resolve({ screen: "overview" }),
  });
  check("an ungated request gets 404, not 403", unauth.status === 404, String(unauth.status));

  const bogus = await GET(new Request("http://localhost/api/admin/live/nope"), {
    params: Promise.resolve({ screen: "nope" }),
  });
  check(
    "an unknown screen is indistinguishable from a wrong path",
    bogus.status === 404,
    String(bogus.status)
  );

  await cleanup();
  console.log("\nAll live-layer checks passed.");
}

main()
  .then(() => process.exit(0))
  .catch(async (e) => {
    console.error(e);
    await cleanup().catch(() => {});
    process.exit(1);
  });
