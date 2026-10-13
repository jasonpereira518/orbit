/**
 * The one-time "your AI credits are here" screen: who is owed it, that it is shown exactly
 * once per account, that a data deletion never replays it, and that its choreography and
 * copy hold together.
 *
 * Run: npx tsx scripts/smoke-credits-intro.ts
 */
import "./smoke/_env";
import { eq, inArray } from "drizzle-orm";
import { getDb } from "../src/db";
import { userSettings } from "../src/db/schema";
import {
  CREDITS_INTRO_LAUNCHED_AT,
  claimCreditsIntroFor,
  isCreditsIntroDue,
} from "../src/lib/credits-intro";
import {
  COUNT,
  GATHER,
  REST,
  SETTLE,
  SHOWER,
  SKIPPABLE_FROM,
  creditsIntroCopy,
  previewNumbers,
} from "../src/lib/credits-intro-scene";
import { PLANS } from "../src/lib/plans/plan-config";
import { ensureUserSettings } from "../src/lib/user-settings";
import { purgeUserData } from "../src/lib/user-data";

const DAY = 24 * 60 * 60 * 1000;
const OLD = "smoke-credits-intro-old";
const NEW = "smoke-credits-intro-new";
const KEPT = "smoke-credits-intro-kept";
const USERS = [OLD, NEW, KEPT];

function check(label: string, condition: boolean, detail?: unknown) {
  if (!condition) throw new Error(`${label} failed${detail === undefined ? "" : `: ${JSON.stringify(detail)}`}`);
  console.log(`  ok  ${label}`);
}

async function cleanup() {
  const db = await getDb();
  await db.delete(userSettings).where(inArray(userSettings.userId, USERS));
}

async function account(userId: string, createdAt: Date) {
  await ensureUserSettings(userId);
  const db = await getDb();
  await db.update(userSettings).set({ createdAt, creditsIntroShownAt: null }).where(eq(userSettings.userId, userId));
}

function pureChecks() {
  console.log("\nchoreography");
  check("stars gather before the medallion settles", GATHER[1] <= SETTLE + 1);
  check("shower and count start after the medallion forms", SHOWER[0] >= SETTLE && COUNT[0] >= SETTLE);
  check("everything lands before rest", SHOWER[1] < REST && COUNT[1] < REST);
  check("skippable well before rest", SKIPPABLE_FROM < SETTLE);

  console.log("\ncopy per plan");
  for (const plan of PLANS) {
    const copy = creditsIntroCopy(plan, previewNumbers(plan));
    check(`${plan}: the rolled number is the plan's monthly allowance`, copy.monthly > 0, copy.monthly);
    check(`${plan}: starter line only on Free`, (copy.starter !== null) === (plan === "free"), copy.starter);
    check(`${plan}: no exclamation marks, footnote names own keys`, !/!/.test(copy.subline + copy.footnote) && /own API key/.test(copy.footnote));
  }
  check("Lifetime says it is newly included", /now included/.test(creditsIntroCopy("lifetime", previewNumbers("lifetime")).unit));
  check("Free with its starter spent drops the starter line",
    creditsIntroCopy("free", { ...previewNumbers("free"), starterCredits: 0 }).starter === null);

  console.log("\neligibility (pure)");
  const before = new Date(CREDITS_INTRO_LAUNCHED_AT.getTime() - 30 * DAY);
  const after = new Date(CREDITS_INTRO_LAUNCHED_AT.getTime() + DAY);
  const base = { createdAt: before, shownAt: null, plan: "free" as const, includedAiAvailable: true };
  check("an account from before launch is owed it", isCreditsIntroDue(base));
  check("an account created after launch is not (onboarding covers it)", !isCreditsIntroDue({ ...base, createdAt: after }));
  check("once shown, never again", !isCreditsIntroDue({ ...base, shownAt: new Date() }));
  check("not while included AI cannot run", !isCreditsIntroDue({ ...base, includedAiAvailable: false }));
  check("every plan with included AI is owed it", PLANS.every((plan) => isCreditsIntroDue({ ...base, plan })));
}

async function claimChecks() {
  console.log("\nthe claim");
  await account(OLD, new Date(CREDITS_INTRO_LAUNCHED_AT.getTime() - 30 * DAY));
  await account(NEW, new Date(CREDITS_INTRO_LAUNCHED_AT.getTime() + DAY));

  const results = await Promise.all([claimCreditsIntroFor(OLD), claimCreditsIntroFor(OLD), claimCreditsIntroFor(OLD)]);
  check("three concurrent tabs: exactly one draws it", results.filter(Boolean).length === 1, results);
  check("a later load draws nothing", (await claimCreditsIntroFor(OLD)) === false);
  check("an account created after launch can never claim it", (await claimCreditsIntroFor(NEW)) === false);

  const db = await getDb();
  const row = await db.query.userSettings.findFirst({ where: eq(userSettings.userId, OLD) });
  check("the showing is stamped", row?.creditsIntroShownAt instanceof Date);

  console.log("\ndata deletion");
  await account(KEPT, new Date(CREDITS_INTRO_LAUNCHED_AT.getTime() - 30 * DAY));
  check("claimed before the deletion", await claimCreditsIntroFor(KEPT));
  await purgeUserData(KEPT);
  const kept = await db.query.userSettings.findFirst({ where: eq(userSettings.userId, KEPT) });
  check("a data deletion keeps the stamp, so it never replays", kept?.creditsIntroShownAt instanceof Date, kept?.creditsIntroShownAt);
  check("…and the account still cannot claim it again", (await claimCreditsIntroFor(KEPT)) === false);
}

async function main() {
  pureChecks();
  await cleanup();
  try {
    await claimChecks();
  } finally {
    await cleanup();
  }
  console.log("\nAll credits-intro checks passed.");
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
