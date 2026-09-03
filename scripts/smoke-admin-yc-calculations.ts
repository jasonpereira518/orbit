/**
 * Pure YC-mode calculations: runway, subscriber growth, unit economics, fundraising
 * progress. No database — every case here is a fixed input/output pair.
 *
 * Run: npx tsx scripts/smoke-admin-yc-calculations.ts
 */
import {
  computeMonthlyBurn,
  computeRunway,
  computeSubscriberGrowth,
  computeCac,
  computeLtv,
  computeFundraisingProgress,
  computeCapitalTotals,
  type CapitalInflow,
} from "../src/lib/admin-yc-calculations";

function check(label: string, condition: boolean, detail?: string) {
  if (!condition) throw new Error(`${label} failed${detail ? `: ${detail}` : ""}`);
  console.log(`  ok  ${label}`);
}

function main() {
  const now = new Date("2026-08-29T00:00:00Z");
  const daysAgo = (n: number) => new Date(now.getTime() - n * 24 * 60 * 60 * 1000);

  /* ------------------------------------------------------------------------- burn */
  const burn = computeMonthlyBurn(
    [
      { amountUsd: 100, incurredAt: daysAgo(5) },
      { amountUsd: 50, incurredAt: daysAgo(20) },
      { amountUsd: 9999, incurredAt: daysAgo(45) }, // outside the trailing-30-day window
    ],
    now
  );
  check("burn sums only the trailing 30 days", burn === 150, `got ${burn}`);

  /* ---------------------------------------------------------------------- runway */
  check("runway divides cash by burn", computeRunway(1500, 300) === 5);
  check("zero burn means infinite runway (null)", computeRunway(1500, 0) === null);
  check("negative burn (net income) also reads as infinite runway", computeRunway(1500, -50) === null);

  /* ------------------------------------------------------------- subscriber growth */
  check("growth from 10 to 15 is +50%", computeSubscriberGrowth(15, 10) === 50);
  check("growth from 10 to 5 is -50%", computeSubscriberGrowth(5, 10) === -50);
  check("0 to 0 has no signal (null)", computeSubscriberGrowth(0, 0) === null);
  check("0 to 3 is null (no prior baseline to compare against)", computeSubscriberGrowth(3, 0) === null);

  /* -------------------------------------------------------------------------- cac */
  check("CAC divides spend by new subscribers", computeCac(500, 10) === 50);
  check("zero new subscribers makes CAC undefined (null)", computeCac(500, 0) === null);

  /* -------------------------------------------------------------------------- ltv */
  check("LTV divides ARPU by churn rate", computeLtv(5, 2) === 250, `got ${computeLtv(5, 2)}`);
  check("no churn estimate makes LTV undefined (null)", computeLtv(5, null) === null);
  check("zero churn also makes LTV undefined (null), not infinite", computeLtv(5, 0) === null);

  /* ------------------------------------------------------------ fundraising progress */
  check("progress divides raised by target", computeFundraisingProgress(100000, 25000) === 25);
  check("zero target reads as 0%, not a divide-by-zero error", computeFundraisingProgress(0, 5000) === 0);
  check("progress can exceed 100% on an oversubscribed round", computeFundraisingProgress(100, 150) === 150);

  /* -------------------------------------------------------------- capital totals */
  // Every case below exists because the number it guards would otherwise overstate how
  // much money the company actually has. See `computeCapitalTotals` for the four rules.
  const inflow = (over: Partial<CapitalInflow> = {}): CapitalInflow => ({
    amountUsd: 1000,
    dilutive: false,
    inKind: false,
    repayable: false,
    repaidUsd: 0,
    receivedAt: daysAgo(10),
    expiresAt: null,
    ...over,
  });

  const empty = computeCapitalTotals([], now);
  check("no funding reads as zero, not null", empty.bankedUsd === 0 && empty.totalCapitalInUsd === 0);

  const banked = computeCapitalTotals(
    [
      inflow({ amountUsd: 500000, dilutive: true }),
      inflow({ amountUsd: 25000, dilutive: false }),
    ],
    now
  );
  check(
    "banked splits dilutive from non-dilutive and sums both",
    banked.dilutiveCashReceivedUsd === 500000 &&
      banked.nonDilutiveCashReceivedUsd === 25000 &&
      banked.bankedUsd === 525000,
    JSON.stringify(banked)
  );

  // Credits do not pay salaries. The whole point of the `form` column.
  const credits = computeCapitalTotals([inflow({ amountUsd: 100000, inKind: true })], now);
  check(
    "in-kind credits never enter banked cash",
    credits.bankedUsd === 0 && credits.inKindActiveUsd === 100000,
    JSON.stringify(credits)
  );
  check(
    "...but they do count toward total capital in",
    credits.totalCapitalInUsd === 100000
  );

  const expired = computeCapitalTotals(
    [inflow({ amountUsd: 100000, inKind: true, expiresAt: daysAgo(1) })],
    now
  );
  check(
    "expired credits count as neither banked nor active",
    expired.bankedUsd === 0 && expired.inKindActiveUsd === 0 && expired.totalCapitalInUsd === 0,
    JSON.stringify(expired)
  );
  check("...but are reported, so the total dropping is explicable", expired.inKindExpiredUsd === 100000);

  // A signed SAFE is not money.
  const promised = computeCapitalTotals(
    [inflow({ amountUsd: 250000, dilutive: true, receivedAt: null })],
    now
  );
  check(
    "committed-but-not-received is excluded from every total",
    promised.bankedUsd === 0 && promised.totalCapitalInUsd === 0,
    JSON.stringify(promised)
  );
  check("...and is reported on its own line", promised.committedNotReceivedUsd === 250000);

  // Loan cash is genuinely in the bank, but it is owed. Counting it as "funding we got"
  // without the liability showing is the one way this page could actively mislead.
  const loan = computeCapitalTotals(
    [
      inflow({ amountUsd: 50000, repayable: true, repaidUsd: 20000 }),
      inflow({ amountUsd: 10000 }),
    ],
    now
  );
  check("loan cash still counts as banked", loan.bankedUsd === 60000, JSON.stringify(loan));
  check("debt outstanding is net of repayments", loan.debtOutstandingUsd === 30000);
  check("net of debt subtracts what is still owed", loan.netOfDebtUsd === 30000);

  // An unreceived loan is not a debt yet — you cannot owe money you have not been given.
  const unwiredLoan = computeCapitalTotals(
    [inflow({ amountUsd: 50000, repayable: true, receivedAt: null })],
    now
  );
  check("an unreceived loan creates no debt", unwiredLoan.debtOutstandingUsd === 0);

  console.log("\nAll YC-calculation checks passed.");
}

main();
process.exit(0);
