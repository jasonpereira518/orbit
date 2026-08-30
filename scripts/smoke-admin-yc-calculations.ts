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

  console.log("\nAll YC-calculation checks passed.");
}

main();
process.exit(0);
