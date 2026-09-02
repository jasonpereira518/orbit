/**
 * The four startup data streams, and the assertions that would otherwise fail silently.
 *
 * Every check here is chosen because its failure mode is *quiet*. Attribution that records
 * last-touch instead of first still produces a tidy channel table — one that credits the
 * wrong channel. A revenue ledger without its unique index still sums to a number — one
 * that is too big. A PMF score over four responses still renders — as a percentage that
 * swings 25 points per reply. None of these throw; they just make the console confidently
 * wrong, which is worse than empty.
 *
 * Run: npx tsx scripts/smoke-instrumentation-streams.ts
 */
import "./smoke/_env";

import { eq, inArray } from "drizzle-orm";
import { getDb } from "../src/db";
import {
  billingEvents,
  feedback,
  gateEvents,
  infraCosts,
  userSettings,
} from "../src/db/schema";
import {
  attributionFromUrl,
  hasSignal,
  parseAttribution,
  referrerHost,
  serializeAttribution,
} from "../src/lib/attribution-parse";
import {
  channelOf,
  recordDirectVisit,
  recordFirstTouch,
} from "../src/lib/attribution";
import {
  classifyMovement,
  currentMrrCents,
  monthlyValueCents,
  mrrMovement,
  recordBillingEvent,
  MONTHLY_CENTS,
} from "../src/lib/billing-events";
import {
  PMF_MINIMUM_RESPONSES,
  pmfSummary,
  recentFeedback,
  recordFeedback,
} from "../src/lib/feedback";
import {
  breakEvenSubscribers,
  monthStart,
  monthlyInfraCents,
  setInfraCost,
} from "../src/lib/infra-costs";
import { recordGateHit } from "../src/lib/gate-events";
import { ensureUserSettings } from "../src/lib/user-settings";

const PREFIX = "smoke-streams-";
const REDDIT = `${PREFIX}reddit`;
const DIRECT = `${PREFIX}direct`;
const LEGACY = `${PREFIX}legacy`;
const ALL = [REDDIT, DIRECT, LEGACY];

function check(label: string, condition: boolean, detail?: string) {
  if (!condition) throw new Error(`${label} failed${detail ? `: ${detail}` : ""}`);
  console.log(`  ok  ${label}`);
}

async function cleanup() {
  const db = await getDb();
  await db.delete(feedback).where(inArray(feedback.userId, ALL));
  await db.delete(gateEvents).where(inArray(gateEvents.userId, ALL));
  await db.delete(billingEvents).where(inArray(billingEvents.userId, ALL));
  await db.delete(infraCosts).where(eq(infraCosts.provider, `${PREFIX}vercel`));
  await db.delete(userSettings).where(inArray(userSettings.userId, ALL));
}

async function read(userId: string) {
  const db = await getDb();
  const row = await db.query.userSettings.findFirst({
    where: eq(userSettings.userId, userId),
  });
  if (!row) throw new Error(`missing row for ${userId}`);
  return row;
}

async function main() {
  await cleanup();
  for (const id of ALL) await ensureUserSettings(id);

  /* ============================================================ A. attribution parsing */

  check(
    "a referrer collapses to its host",
    referrerHost("https://www.reddit.com/r/startups/comments/abc/def") === "reddit.com",
    String(referrerHost("https://www.reddit.com/r/startups/comments/abc/def"))
  );

  // Without this the one channel that mattered renders as forty buckets of one, which
  // looks exactly like no channel mattering.
  check(
    "two different threads on one site are the same channel",
    referrerHost("https://reddit.com/r/a/1") === referrerHost("https://reddit.com/r/b/2")
  );

  const utm = attributionFromUrl(
    "https://orbit.test/pricing?utm_source=Reddit&utm_medium=Social&utm_campaign=Launch",
    "https://news.ycombinator.com/item?id=1"
  );
  check(
    "utm values are lowercased so the rollup does not split on case",
    utm.utmSource === "reddit" && utm.utmMedium === "social" && utm.utmCampaign === "launch",
    JSON.stringify(utm)
  );
  check("the landing path is kept verbatim", utm.landingPath === "/pricing");

  // An empty parameter is absence, not a value — otherwise "" becomes its own channel.
  const blank = attributionFromUrl("https://orbit.test/?utm_source=", null);
  check("an empty utm_source is null, not an empty string", blank.utmSource === null);
  check("a bare direct visit carries no signal", !hasSignal(blank));

  check(
    "a malformed cookie is discarded rather than thrown",
    parseAttribution("{not json") === null
  );
  check("an empty cookie is discarded", parseAttribution("") === null);
  check(
    "a cookie round-trips",
    parseAttribution(serializeAttribution(utm))?.utmSource === "reddit"
  );

  /* ========================================================== A. attribution first-touch */

  await recordFirstTouch(REDDIT, {
    referrer: "reddit.com",
    utmSource: null,
    utmMedium: null,
    utmCampaign: null,
    landingPath: "/",
  });

  // THE ONE THAT MATTERS. A later visit from elsewhere must not overwrite the channel that
  // actually acquired them — last-touch attribution is the default mistake here and it
  // produces a table that looks perfectly reasonable while crediting the wrong source.
  const claimedAgain = await recordFirstTouch(REDDIT, {
    referrer: "google.com",
    utmSource: "newsletter",
    utmMedium: null,
    utmCampaign: null,
    landingPath: "/pricing",
  });
  const reddit = await read(REDDIT);
  check("a second touch does not claim the row", claimedAgain === false);
  check(
    "first touch survives a later visit from another channel",
    reddit.signupReferrer === "reddit.com" && reddit.signupUtmSource === null,
    `${reddit.signupReferrer} / ${reddit.signupUtmSource}`
  );

  await recordDirectVisit(DIRECT);
  const direct = await read(DIRECT);
  check(
    "a direct visit is attributed with no channel",
    direct.signupAttributedAt !== null && direct.signupReferrer === null
  );

  // The distinction the timestamp column exists for.
  const legacy = await read(LEGACY);
  check("an untouched account stays unattributed", legacy.signupAttributedAt === null);
  check("...and is reported as such", channelOf(legacy) === "unattributed");
  check("...distinctly from a real direct visit", channelOf(direct) === "direct");
  check("a referred account reports its host", channelOf(reddit) === "reddit.com");

  /* ================================================================= C. revenue movement */

  check(
    "an active subscription is worth the monthly price",
    monthlyValueCents("active", null) === MONTHLY_CENTS
  );

  // Cancelled-but-paid-through is still revenue: `resolvePlan` honours the remaining time,
  // so booking the churn early would show money gone while the entitlement is still live.
  const future = new Date(Date.now() + 10 * 86_400_000);
  check(
    "a cancelled subscription still counts until its period ends",
    monthlyValueCents("canceled", future) === MONTHLY_CENTS
  );
  check(
    "...and stops counting once it has",
    monthlyValueCents("canceled", new Date(Date.now() - 86_400_000)) === 0
  );

  check(
    "nothing to something is new business",
    classifyMovement(0, 500)?.kind === "new"
  );
  check(
    "something to nothing is churn, and the delta is negative",
    classifyMovement(500, 0)?.kind === "churn" &&
      classifyMovement(500, 0)?.deltaCents === -500
  );
  check("no change produces no event", classifyMovement(500, 500) === null);

  const t0 = new Date("2026-06-15T00:00:00Z");
  await recordBillingEvent({
    source: "clerk",
    eventId: `${PREFIX}evt-1`,
    kind: "new",
    userId: REDDIT,
    mrrDeltaCents: 500,
    effectiveAt: t0,
  });

  // THE OTHER ONE THAT MATTERS. Svix retries; without the unique index a redelivery would
  // add another $5 to MRR and nothing would ever flag it.
  const dupe = await recordBillingEvent({
    source: "clerk",
    eventId: `${PREFIX}evt-1`,
    kind: "new",
    userId: REDDIT,
    mrrDeltaCents: 500,
    effectiveAt: t0,
  });
  check("a redelivered event is not recorded twice", dupe === false);

  await recordBillingEvent({
    source: "clerk",
    eventId: `${PREFIX}evt-2`,
    kind: "churn",
    userId: DIRECT,
    mrrDeltaCents: -500,
    effectiveAt: new Date("2026-06-20T00:00:00Z"),
  });
  await recordBillingEvent({
    source: "stripe",
    eventId: `${PREFIX}evt-3`,
    kind: "lifetime",
    userId: LEGACY,
    amountCents: 9900,
    effectiveAt: new Date("2026-06-21T00:00:00Z"),
  });
  await recordBillingEvent({
    source: "stripe",
    eventId: `${PREFIX}evt-4`,
    kind: "refund",
    userId: LEGACY,
    amountCents: 9900,
    effectiveAt: new Date("2026-06-22T00:00:00Z"),
  });

  const move = await mrrMovement(
    new Date("2026-06-01T00:00:00Z"),
    new Date("2026-07-01T00:00:00Z")
  );
  check("new business is counted once, not twice", move.newCents === 500);
  check("churn is negative", move.churnCents === -500);
  check("net movement is new plus churn", move.netCents === 0, String(move.netCents));

  // Folding one-time revenue into MRR is the easiest way to produce a number that looks
  // like MRR and is not. A $99 Lifetime sale must not read as $99/month.
  check("a Lifetime sale does not touch MRR", move.oneTimeCents === 9900);
  check("...and is excluded from net recurring movement", move.netCents === 0);
  check("a refund is tracked as cash, not as churn", move.refundedCents === 9900);

  const outside = await mrrMovement(
    new Date("2026-07-01T00:00:00Z"),
    new Date("2026-08-01T00:00:00Z")
  );
  check("the window actually filters", outside.newCents === 0);

  // Two independent derivations of the same quantity: this one reads live subscription
  // state, the ledger sums movements. Disagreement means a dropped webhook.
  const db = await getDb();
  await db
    .update(userSettings)
    .set({ subscriptionPlan: "orbit", subscriptionStatus: "active" })
    .where(eq(userSettings.userId, REDDIT));
  const live = await currentMrrCents();
  check("current MRR sees an active subscriber", live >= MONTHLY_CENTS, String(live));

  // A comped account pays nothing however its billing columns read — otherwise every
  // comp inflates MRR by $5 and the Money screen quietly overstates revenue.
  await db
    .update(userSettings)
    .set({ compedPlan: "orbit" })
    .where(eq(userSettings.userId, REDDIT));
  const afterComp = await currentMrrCents();
  check(
    "a comped account contributes no revenue",
    afterComp === live - MONTHLY_CENTS,
    `${afterComp} vs ${live}`
  );

  /* ========================================================================= B. feedback */

  await recordFeedback({ userId: REDDIT, kind: "pmf", score: 3 });
  await recordFeedback({ userId: DIRECT, kind: "pmf", score: 1 });
  await recordFeedback({
    userId: LEGACY,
    kind: "churn_reason",
    text: "  Went back to a spreadsheet.  ",
  });

  const summary = await pmfSummary();
  check("pmf responses are counted", summary.total >= 2);

  // Below the floor the percentage is withheld, because with four responses it can only be
  // 0/25/50/75/100 and moves 25 points on one reply — a coin flip rendered as a trend.
  check(
    "the pmf score is withheld below the response floor",
    summary.total < PMF_MINIMUM_RESPONSES ? summary.score === null : true,
    `${summary.total} responses, score ${summary.score}`
  );

  const verbatims = await recentFeedback({ kind: "churn_reason" });
  check(
    "churn reasons come back trimmed and verbatim",
    verbatims[0]?.text === "Went back to a spreadsheet.",
    String(verbatims[0]?.text)
  );

  // A blank submission is a mis-click, not a data point.
  const beforeBlank = (await recentFeedback({ limit: 200 })).length;
  await recordFeedback({ userId: REDDIT, kind: "freeform", text: "   " });
  check(
    "an empty freeform submission records nothing",
    (await recentFeedback({ limit: 200 })).length === beforeBlank
  );

  // Out-of-range scores are clamped rather than stored — a 7 on a 3-point scale would
  // silently vanish from every bucket and make the totals disagree with the count.
  await recordFeedback({ userId: DIRECT, kind: "pmf", score: 9 });
  const clamped = await pmfSummary();
  check(
    "an out-of-range pmf score is clamped into the scale",
    clamped.veryDisappointed + clamped.somewhatDisappointed + clamped.notDisappointed ===
      clamped.total
  );

  /* ====================================================================== D. infra costs */

  const month = new Date("2026-06-14T12:00:00Z");
  await setInfraCost({ provider: `${PREFIX}vercel`, month, amountCents: 2000 });

  // Bills get restated. A second entry must replace the first, not double the total.
  await setInfraCost({ provider: `${PREFIX}vercel`, month, amountCents: 2500 });
  const total = await monthlyInfraCents(month);
  check("a restated bill replaces rather than doubles", total === 2500, String(total));

  check(
    "any day of the month resolves to the same row",
    monthStart(new Date("2026-06-01T00:00:00Z")).getTime() ===
      monthStart(new Date("2026-06-30T23:59:59Z")).getTime()
  );

  check("break-even divides fixed cost by contribution", breakEvenSubscribers(2500, 500) === 5);
  check("...rounding up, because you cannot have a fraction of a subscriber", breakEvenSubscribers(2600, 500) === 6);

  // `Infinity` on a dashboard reads as a bug. Null forces the UI to say "not from here".
  check(
    "break-even is null when no account contributes anything",
    breakEvenSubscribers(2500, 0) === null
  );
  check("...and when contribution is negative", breakEvenSubscribers(2500, -100) === null);

  /* ======================================================================= E. gate events */

  await recordGateHit({ userId: DIRECT, feature: "contacts", plan: "free", context: { contactLimit: 100 } });
  await recordGateHit({ userId: DIRECT, feature: "outreach", plan: "free" });

  const hits = await db
    .select()
    .from(gateEvents)
    .where(eq(gateEvents.userId, DIRECT));
  check("gate refusals are recorded", hits.length === 2);

  // Denormalised on purpose: the row means "their plan was free when they hit this wall".
  // Reading it off `user_settings` later would answer for today, and the interesting rows
  // are exactly the ones where the plan has since changed.
  check(
    "the plan at the time is stored on the row",
    hits.every((h) => h.plan === "free")
  );
  check(
    "the contact cap is recorded as its own feature",
    hits.some((h) => h.feature === "contacts")
  );

  await cleanup();
  console.log("\nAll instrumentation-stream checks passed.");
}

main()
  .then(() => {
    process.exit(0);
  })
  .catch(async (e) => {
    console.error(e);
    await cleanup().catch(() => {});
    process.exit(1);
  });
