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
  computeArpaCents,
  computeGrossMargin,
  computeObservedChurnPct,
  computePaybackMonths,
  resolveLtv,
  summarizeSubscriberLedger,
  MIN_SUBSCRIBER_MONTHS,
  type CapitalInflow,
  type LedgerMrrRow,
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

  /* ------------------------------------------------- LTV from the ledger (1.13) */
  // A 30-day window (exactly one subscriber-month of time per full-window subscriber) and
  // five accounts that cover every transition the replay has to get right.
  const D0 = new Date("2026-06-01T00:00:00Z");
  const from = (days: number) => new Date(D0.getTime() + days * 24 * 60 * 60 * 1000);
  const m = (userId: string, days: number, mrrDeltaCents: number): LedgerMrrRow => ({
    userId,
    effectiveAt: from(days),
    mrrDeltaCents,
  });
  const ledger: LedgerMrrRow[] = [
    m("a", -10, 1000), //                          paying the whole window
    m("b", 15, 500), m("b", 25, -500), //          joins and leaves inside it
    m("c", 20, 800), m("c", 25, 200), //           joins, then expands (still one logo)
    m("d", -40, 300), m("d", -5, -300), //         churned before it: not a subscriber
    m("e", -1, 400), m("e", 10, -400), m("e", 20, 400), // churns, then returns
    m("a", 40, -1000), //                          after the window: ignored
  ];
  const summary = summarizeSubscriberLedger([...ledger].reverse(), D0, from(30));
  const near = (a: number, b: number) => Math.abs(a - b) < 1e-9;
  check(
    "subscriber-months integrate exactly: 1 + 1/3 + 1/3 + 2/3",
    near(summary.subscriberMonths, 1 + 1 / 3 + 1 / 3 + 2 / 3),
    String(summary.subscriberMonths)
  );
  check(
    "MRR-months follow each account's level over time (an expansion mid-stay counts at both levels)",
    near(summary.mrrCentMonths, 1000 + 500 / 3 + 300 + 800 / 3),
    String(summary.mrrCentMonths)
  );
  check("logo churn counts the two accounts that stopped paying", summary.churned === 2);
  check("acquisitions count joins and returns, not expansions", summary.acquired === 3);
  check("two accounts were paying at the start and three at the end", summary.startSubscribers === 2 && summary.endSubscribers === 3, JSON.stringify(summary));
  check("rows after the window are ignored; input order does not matter", near(summarizeSubscriberLedger(ledger, D0, from(30)).subscriberMonths, summary.subscriberMonths));
  const emptySummary = summarizeSubscriberLedger([], D0, from(30));
  check("an empty ledger is all zeros", emptySummary.subscriberMonths === 0 && emptySummary.churned === 0);

  const arpa = computeArpaCents(summary.mrrCentMonths, summary.subscriberMonths);
  check("ARPA is MRR-months over subscriber-months", arpa !== null && near(arpa, (1000 + 500 / 3 + 300 + 800 / 3) / (7 / 3)), String(arpa));
  check("ARPA with no subscriber time is undefined (null)", computeArpaCents(0, 0) === null);
  check("observed churn is accounts lost per subscriber-month, as a percent", near(computeObservedChurnPct(2, 8) ?? -1, 25));
  check("…and undefined with no subscriber time", computeObservedChurnPct(0, 0) === null);

  check("gross margin is (revenue - cost) / revenue", computeGrossMargin(10_000, 2_500) === 0.75);
  check("a margin can be negative", (computeGrossMargin(1_000, 1_500) ?? 0) < 0);
  check("no revenue means no margin (null), not 0% or 100%", computeGrossMargin(0, 100) === null);
  check("payback is CAC over monthly gross profit", near(computePaybackMonths(60, 9, 0.75) ?? -1, 60 / 6.75));
  check("payback is undefined without a CAC, an ARPA, a margin, or a positive profit",
    computePaybackMonths(null, 9, 0.75) === null && computePaybackMonths(60, null, 0.75) === null &&
      computePaybackMonths(60, 9, null) === null && computePaybackMonths(60, 9, -0.1) === null);

  const observed = resolveLtv({ arpaUsd: 9, grossMargin: 0.8, subscriberMonths: MIN_SUBSCRIBER_MONTHS + 50, observedChurnPct: 2, typedChurnPct: 5 });
  check("LTV uses OBSERVED churn once there are 100 subscriber-months: 9 x 0.8 / 2% = $360", observed.basis === "observed" && near(observed.ltvUsd, 360), JSON.stringify(observed));
  const estimate = resolveLtv({ arpaUsd: 9, grossMargin: 0.8, subscriberMonths: MIN_SUBSCRIBER_MONTHS - 1, observedChurnPct: 2, typedChurnPct: 5 });
  check("one subscriber-month short, it uses the typed churn and says estimate: 9 x 0.8 / 5% = $144", estimate.basis === "estimate" && near(estimate.ltvUsd, 144), JSON.stringify(estimate));
  const noCancels = resolveLtv({ arpaUsd: 9, grossMargin: 0.8, subscriberMonths: 500, observedChurnPct: 0, typedChurnPct: null });
  check("zero observed cancellations is not infinite LTV: none, with a reason", noCancels.basis === "none" && noCancels.ltvUsd === null && /cancellations/.test(noCancels.reason), JSON.stringify(noCancels));
  const tooFew = resolveLtv({ arpaUsd: 9, grossMargin: 0.8, subscriberMonths: 12, observedChurnPct: 8, typedChurnPct: null });
  check("too little data and no estimate: none, saying how much is missing", tooFew.basis === "none" && /12 of 100/.test(tooFew.reason), JSON.stringify(tooFew));
  check("no subscribers or no revenue: none", resolveLtv({ arpaUsd: null, grossMargin: 0.8, subscriberMonths: 0, observedChurnPct: null, typedChurnPct: 3 }).basis === "none" &&
    resolveLtv({ arpaUsd: 9, grossMargin: null, subscriberMonths: 0, observedChurnPct: null, typedChurnPct: 3 }).basis === "none");
  const underwater = resolveLtv({ arpaUsd: 9, grossMargin: -0.2, subscriberMonths: 200, observedChurnPct: 2, typedChurnPct: null });
  check("a negative margin gives an LTV of 0, never a negative lifetime value", underwater.basis === "observed" && underwater.ltvUsd === 0);

  console.log("\nAll YC-calculation checks passed.");
}

main();
process.exit(0);
