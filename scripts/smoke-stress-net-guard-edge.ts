/**
 * The audit's stress proofs for `stress-tests/net-guard-edge.ts`, run in the smoke suite (FIX_PLAN
 * Phase 4.1). Every finding there was fixed, so under STRESS_STRICT a `BUG` line is a
 * regression and fails the run, as a harness failure always did. The stress script stays
 * where it is as the audit's record. Run: npx tsx scripts/smoke-stress-net-guard-edge.ts
 *
 * Under `run-smoke.ts`, `scripts/smoke/hermetic.mjs` answers every public name with one public
 * address, which would make `127.0.0.1.nip.io` look harmless. The wildcard-DNS services are
 * answered here as public DNS answers them, with the address embedded in the name, so the
 * check means the same in a hermetic run as against real DNS.
 */
import "./smoke/_env";
import dns from "node:dns";
import dnsPromises from "node:dns/promises";
import { syncBuiltinESMExports } from "node:module";

const WILDCARD_DNS = /(?:^|\.)(\d{1,3}(?:\.\d{1,3}){3})\.(?:nip|sslip)\.io\.?$/i;
const fallback = dnsPromises.lookup;
const wildcardLookup = (async (hostname: string, options?: unknown) => {
  const embedded = WILDCARD_DNS.exec(String(hostname))?.[1];
  if (!embedded) return (fallback as (h: string, o?: unknown) => Promise<unknown>)(hostname, options);
  const all = typeof options === "object" && options !== null && Boolean((options as { all?: boolean }).all);
  return all ? [{ address: embedded, family: 4 }] : { address: embedded, family: 4 };
}) as typeof dnsPromises.lookup;
dns.promises.lookup = wildcardLookup;
dnsPromises.lookup = wildcardLookup;
syncBuiltinESMExports();

process.env.STRESS_STRICT = "1";
void import("../stress-tests/net-guard-edge");
