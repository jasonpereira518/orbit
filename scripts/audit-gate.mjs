#!/usr/bin/env node
/**
 * CI's dependency audit: `npm audit --omit=dev`, failing on any high or critical advisory
 * EXCEPT the ones below. npm has no ignore flag, and an advisory with no patched release
 * would otherwise block every PR until upstream ships one.
 *
 * Every entry needs a reason it cannot reach Orbit, and comes out once a fix exists.
 */
import { execSync } from "node:child_process";

const ALLOWED = {
  // picomatch ReDoS (<= 4.0.7, no patched release as of 2026-11-17). Only path is
  // @sentry/nextjs -> @rollup/plugin-commonjs, a build-time bundler plugin matching globs
  // from our own config; no user input ever reaches it at runtime. Approved by Jason.
  "GHSA-fc5q-39xc-vjpf": "build-time only, no patched picomatch yet",
};

let out;
try {
  out = execSync("npm audit --omit=dev --json", { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });
} catch (err) {
  out = err.stdout; // npm audit exits non-zero whenever it finds anything
}
const report = JSON.parse(out);

const blocking = new Map();
for (const vuln of Object.values(report.vulnerabilities ?? {})) {
  for (const via of vuln.via) {
    if (typeof via !== "object" || !["high", "critical"].includes(via.severity)) continue;
    const id = via.url?.split("/").pop();
    if (id && ALLOWED[id]) continue;
    blocking.set(id ?? via.title, `${via.severity}  ${via.name}  ${via.title}  ${via.url ?? ""}`);
  }
}

for (const [id, why] of Object.entries(ALLOWED)) console.log(`audit-gate: allowed ${id} (${why})`);
if (blocking.size) {
  console.error(`audit-gate: ${blocking.size} high/critical production advisory(ies):`);
  for (const line of blocking.values()) console.error(`  ${line}`);
  process.exit(1);
}
console.log("audit-gate: ok, no blocking high/critical production advisories");
