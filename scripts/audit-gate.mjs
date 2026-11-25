#!/usr/bin/env node
/**
 * CI's dependency audit: `npm audit --omit=dev`, failing on any high or critical advisory
 * EXCEPT the ones below. npm has no ignore flag, and an advisory with no patched release
 * would otherwise block every PR until upstream ships one.
 *
 * Run over the app and over the browser extension, which has its own lockfile and ships its
 * production dependencies in its bundle. Each has its own allowlist: an exception in one is
 * never one in the other.
 *
 * Every entry needs a reason it cannot reach Orbit, and comes out once a fix exists.
 */
import { execSync } from "node:child_process";

const PROJECTS = {
  ".": {
    // picomatch ReDoS (<= 4.0.7, no patched release as of 2026-11-17). Only path is
    // @sentry/nextjs -> @rollup/plugin-commonjs, a build-time bundler plugin matching globs
    // from our own config; no user input ever reaches it at runtime. Approved by Jason.
    "GHSA-fc5q-39xc-vjpf": "build-time only, no patched picomatch yet",
  },
  extension: {
    // image-size DoS (<= 2.0.2). Only path is @clerk/chrome-extension's Solana wallet chain
    // (-> react-native -> metro), a peer the extension never enables; metro pins ^1.0.2, so
    // no patched image-size fits. metro is build tooling that never runs in the extension.
    "GHSA-5p2g-fcmc-qvqq": "metro's image parser, via Clerk's unused wallet chain; no fix in range",
    "GHSA-w3rx-r6r6-pgpr": "same package and path as GHSA-5p2g-fcmc-qvqq",
  },
};

let failed = false;
for (const [dir, allowed] of Object.entries(PROJECTS)) {
  const label = dir === "." ? "app" : dir;
  let out;
  try {
    out = execSync("npm audit --omit=dev --json", { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });
  } catch (err) {
    out = err.stdout; // npm audit exits non-zero whenever it finds anything
  }
  const report = JSON.parse(out);

  const blocking = new Map();
  for (const vuln of Object.values(report.vulnerabilities ?? {})) {
    for (const via of vuln.via) {
      if (typeof via !== "object" || !["high", "critical"].includes(via.severity)) continue;
      const id = via.url?.split("/").pop();
      if (id && allowed[id]) continue;
      blocking.set(id ?? via.title, `${via.severity}  ${via.name}  ${via.title}  ${via.url ?? ""}`);
    }
  }

  for (const [id, why] of Object.entries(allowed)) console.log(`audit-gate (${label}): allowed ${id} (${why})`);
  if (blocking.size) {
    failed = true;
    console.error(`audit-gate (${label}): ${blocking.size} high/critical production advisory(ies):`);
    for (const line of blocking.values()) console.error(`  ${line}`);
  } else {
    console.log(`audit-gate (${label}): ok, no blocking high/critical production advisories`);
  }
}
if (failed) process.exit(1);
