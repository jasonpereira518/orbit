/**
 * Invokes the YC-mode pages against seeded data.
 *
 * WHY THIS EXISTS. `/admin/yc/*` is unreachable in a browser without Clerk keys and an
 * `ADMIN_USER_IDS` entry — `src/proxy.ts` 404s the whole surface in demo mode — so there is
 * no local way to click through it. Calling the page functions directly runs every loader
 * and builds the whole element tree, which catches what actually breaks here: a loader that
 * throws, a column that was never selected, a null dereference in a row mapping.
 *
 * WHAT IT DOES NOT COVER: client components render as elements, not DOM, so this proves
 * the forms and charts receive well-formed props, not that they behave.
 *
 * Run: npx tsx scripts/smoke-admin-yc-render.ts
 */
import "./smoke/_env";

import { eq, like } from "drizzle-orm";
import { getDb } from "../src/db";
import {
  cashSnapshots,
  fundraisingInvestors,
  fundraisingRounds,
  nonDilutiveFunding,
} from "../src/db/schema";
import { loadFundingTotals } from "../src/lib/admin-yc-metrics";

const PREFIX = "smoke-yc-";

function check(label: string, condition: boolean, detail?: string) {
  if (!condition) throw new Error(`${label} failed${detail ? `: ${detail}` : ""}`);
  console.log(`  ok  ${label}`);
}

/** Runs first as well as last: a previous aborted run leaves rows that skew every total. */
async function cleanup() {
  const db = await getDb();
  await db.delete(fundraisingInvestors).where(like(fundraisingInvestors.name, `${PREFIX}%`));
  await db.delete(fundraisingRounds).where(like(fundraisingRounds.name, `${PREFIX}%`));
  await db.delete(nonDilutiveFunding).where(like(nonDilutiveFunding.source, `${PREFIX}%`));
}

/** Flatten a React element tree to the strings it would render. */
function textOf(node: unknown, out: string[] = []): string[] {
  if (node == null || typeof node === "boolean") return out;
  if (typeof node === "string" || typeof node === "number") {
    out.push(String(node));
    return out;
  }
  if (Array.isArray(node)) {
    for (const child of node) textOf(child, out);
    return out;
  }
  const el = node as { props?: Record<string, unknown> };
  if (el.props) {
    for (const [key, value] of Object.entries(el.props)) {
      if (key === "children" || typeof value === "object") textOf(value, out);
      else if (typeof value === "string" || typeof value === "number") out.push(String(value));
    }
  }
  return out;
}

async function main() {
  await cleanup();
  const db = await getDb();
  const now = new Date();
  const daysAgo = (n: number) => new Date(now.getTime() - n * 24 * 60 * 60 * 1000);

  /* ------------------------------------------------------------------------- seed */
  const [round] = await db
    .insert(fundraisingRounds)
    .values({ name: `${PREFIX}pre-seed`, targetUsd: 500_000 })
    .returning();
  if (!round) throw new Error("seed: round insert returned nothing");

  await db.insert(fundraisingInvestors).values([
    // Wired.
    {
      roundId: round.id,
      name: `${PREFIX}wired`,
      amountUsd: 200_000,
      committedAt: daysAgo(30),
      receivedAt: daysAgo(20),
    },
    // Signed, not wired — must not count as money.
    {
      roundId: round.id,
      name: `${PREFIX}promised`,
      amountUsd: 100_000,
      committedAt: daysAgo(5),
      receivedAt: null,
    },
  ]);

  await db.insert(nonDilutiveFunding).values([
    {
      source: `${PREFIX}grant`,
      kind: "grant",
      form: "cash",
      amountUsd: 25_000,
      awardedAt: daysAgo(60),
      receivedAt: daysAgo(50),
    },
    {
      source: `${PREFIX}credits-live`,
      kind: "credit",
      form: "in_kind",
      amountUsd: 10_000,
      awardedAt: daysAgo(60),
      receivedAt: daysAgo(60),
      expiresAt: new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000),
    },
    {
      source: `${PREFIX}credits-dead`,
      kind: "credit",
      form: "in_kind",
      amountUsd: 99_000,
      awardedAt: daysAgo(400),
      receivedAt: daysAgo(400),
      expiresAt: daysAgo(1),
    },
    {
      source: `${PREFIX}loan`,
      kind: "loan",
      form: "cash",
      repayable: true,
      repaidUsd: 4_000,
      amountUsd: 10_000,
      awardedAt: daysAgo(90),
      receivedAt: daysAgo(90),
    },
  ]);

  /* ---------------------------------------------------------------------- totals */
  const { totals, rounds, nonDilutive } = await loadFundingTotals(now);
  const seeded = rounds.find((r) => r.id === round.id);
  if (!seeded) throw new Error("seeded round missing from loadFundingTotals");

  check(
    "banked counts wired equity, grant cash and loan cash — and nothing else",
    totals.bankedUsd === 235_000,
    `got ${totals.bankedUsd}`
  );
  check("dilutive cash is the wired commitment only", totals.dilutiveCashReceivedUsd === 200_000);
  check("live credits are active, expired ones are not", totals.inKindActiveUsd === 10_000);
  check("the expired credit is reported separately", totals.inKindExpiredUsd === 99_000);
  check("the unwired commitment is excluded", totals.committedNotReceivedUsd === 100_000);
  check("debt is net of repayment", totals.debtOutstandingUsd === 6_000);
  check("total capital in is banked plus live credits", totals.totalCapitalInUsd === 245_000);
  check("net of debt subtracts what is owed", totals.netOfDebtUsd === 239_000);

  check(
    "round progress is measured on commitments",
    seeded.committedUsd === 300_000 && seeded.progressPct === 60,
    `${seeded.committedUsd} / ${seeded.progressPct}%`
  );
  check("round received is the wired half only", seeded.receivedUsd === 200_000);
  check(
    "the expired credit is flagged for the table",
    nonDilutive.find((r) => r.source === `${PREFIX}credits-dead`)?.expired === true
  );

  /* ----------------------------------------------------------------- page render */
  // Imported here rather than at the top so a seeding failure above reports as itself
  // instead of as a render error.
  const { default: FundingPage } = await import("../src/app/(admin)/admin/yc/fundraising/page");
  const { default: RunwayPage } = await import("../src/app/(admin)/admin/yc/runway/page");
  const { default: RevenuePage } = await import("../src/app/(admin)/admin/yc/revenue/page");

  const funding = textOf(await FundingPage());
  check("Funding renders the banked total", funding.includes("$235,000"), funding.slice(0, 40).join("|"));
  check("Funding renders total capital in", funding.includes("$245,000"));
  check("Funding shows the derivation, not just the headline", funding.includes("= In the bank"));
  check("Funding names the expired credit as excluded", funding.some((t) => t.includes("excluded above")));
  check("Funding reconciles against cash on hand", funding.includes("Reconciliation"));

  // Runway with no cash snapshot at all: the page must render rather than divide by null.
  const runwayEmpty = textOf(await RunwayPage());
  check("Runway renders with no cash snapshot", runwayEmpty.includes("Runway"));
  check(
    "...and says infrastructure was never entered rather than showing $0",
    runwayEmpty.some((t) => t.includes("not entered")),
    runwayEmpty.join("|").slice(0, 200)
  );

  const [snapshot] = await db
    .insert(cashSnapshots)
    .values({ balanceUsd: 120_000, asOf: now })
    .returning();
  const runway = textOf(await RunwayPage());
  check("Runway picks up the cash snapshot", runway.includes("$120,000"));
  check("Runway breaks burn into its parts", runway.includes("= Monthly burn"));

  const revenue = textOf(await RevenuePage());
  check("Revenue renders the movement waterfall", revenue.includes("MRR movement (30d)"));
  check(
    "...and says so when there is no ledger yet, instead of showing a confident zero",
    revenue.some((t) => t.includes("No billing events recorded yet")) ||
      revenue.some((t) => t.includes("ledger begins"))
  );

  // Only the row this run inserted. `cash_snapshots` has no name to prefix, so it is
  // tracked by id rather than swept — a blanket delete here would wipe real local data.
  if (snapshot) {
    await db.delete(cashSnapshots).where(eq(cashSnapshots.id, snapshot.id));
  }
  await cleanup();
  console.log("\nAll YC render checks passed.");
}

main()
  .then(() => process.exit(0))
  .catch(async (err) => {
    console.error(err);
    await cleanup().catch(() => {});
    process.exit(1);
  });
