/**
 * The audit's stress proofs for `stress-tests/resilience-repros.ts`, run in the smoke suite (FIX_PLAN
 * Phase 4.1). Every finding there was fixed, so under STRESS_STRICT a `BUG` line is a
 * regression and fails the run, as a harness failure always did. The stress script stays
 * where it is as the audit's record. Run: npx tsx scripts/smoke-stress-resilience-repros.ts
 */
import "./smoke/_env";

process.env.STRESS_STRICT = "1";
void import("../stress-tests/resilience-repros");
