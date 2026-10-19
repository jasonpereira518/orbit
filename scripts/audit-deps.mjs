#!/usr/bin/env node
/**
 * Dependency audit for CI (FIX_PLAN Phase 4.3): fails on any high or critical advisory in a
 * production dependency that is not allowlisted below.
 *
 * The allowlist is by advisory id, and narrow on purpose: each entry also names the one
 * top-level package it is allowed to arrive through. The script walks package-lock.json for
 * every production path to the vulnerable package, so the same advisory reached any other
 * way fails.
 *
 *   node scripts/audit-deps.mjs            (needs the registry; CI only)
 *
 * Today's entries are the `@clerk/ui` → `@solana/wallet-adapter-react` → `react-native` →
 * `metro` chain: wallet sign-in code Clerk bundles and Orbit never enables, whose DoS
 * advisories are in build tooling (metro) that never runs in Orbit's server or browser.
 * Remove an entry once Clerk ships without it; a stale entry prints a notice.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const ALLOWLIST = {
  "GHSA-5p2g-fcmc-qvqq": { pkg: "image-size", via: "@clerk/ui", why: "metro's image parser, reached only through Clerk's unused Solana wallet chain" },
  "GHSA-w3rx-r6r6-pgpr": { pkg: "image-size", via: "@clerk/ui", why: "same package and path as GHSA-5p2g-fcmc-qvqq" },
  "GHSA-vfj7-8cjw-p6xm": { pkg: "braces", via: "@clerk/ui", why: "metro-file-map → micromatch, reached only through Clerk's unused Solana wallet chain" },
};

const FAIL_AT = new Set(["high", "critical"]);

function npmJson(args) {
  try {
    return JSON.parse(execFileSync("npm", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }));
  } catch (err) {
    // `npm audit` and `npm ls` exit non-zero when they find something; the JSON is still on stdout.
    if (err.stdout) return JSON.parse(err.stdout);
    throw err;
  }
}

/**
 * For each production package in package-lock.json, the top-level dependencies it is
 * reachable from. Read from the lockfile rather than `npm ls` so it needs no install, and
 * cannot pass vacuously when node_modules is absent.
 */
function topLevelOrigins() {
  const lock = JSON.parse(readFileSync("package-lock.json", "utf8"));
  const pkgs = lock.packages ?? {};
  // Peers too: npm installs them, and Clerk's wallet chain reaches react-native only as a peer.
  const deps = (entry) => ({
    ...(entry?.dependencies ?? {}),
    ...(entry?.optionalDependencies ?? {}),
    ...(entry?.peerDependencies ?? {}),
  });
  // Node resolution: the nearest node_modules/<name> walking up from the dependent.
  const resolve = (from, name) => {
    let base = from;
    for (;;) {
      const key = base ? `${base}/node_modules/${name}` : `node_modules/${name}`;
      if (pkgs[key]) return key;
      if (!base) return null;
      const i = base.lastIndexOf("/node_modules/");
      base = i === -1 ? "" : base.slice(0, i);
    }
  };
  const origins = new Map();
  for (const top of Object.keys(pkgs[""]?.dependencies ?? {})) {
    const start = resolve("", top);
    if (!start) continue;
    const stack = [start];
    const seen = new Set();
    while (stack.length) {
      const key = stack.pop();
      if (seen.has(key) || pkgs[key]?.dev) continue;
      seen.add(key);
      if (!origins.has(key)) origins.set(key, new Set());
      origins.get(key).add(top);
      for (const name of Object.keys(deps(pkgs[key]))) {
        const next = resolve(key, name);
        if (next) stack.push(next);
      }
    }
  }
  return origins;
}

/** The top-level dependencies the package `name` is reachable from, in production. */
function originsOf(name, origins) {
  const out = new Set();
  for (const [key, tops] of origins) {
    if (key === `node_modules/${name}` || key.endsWith(`/node_modules/${name}`)) for (const t of tops) out.add(t);
  }
  return out;
}

const report = npmJson(["audit", "--omit=dev", "--json"]);
const advisories = new Map();
for (const [pkg, v] of Object.entries(report.vulnerabilities ?? {})) {
  for (const via of v.via) {
    if (typeof via !== "object" || !FAIL_AT.has(via.severity)) continue;
    const id = String(via.url ?? "").split("/").pop() || String(via.source);
    advisories.set(id, { id, pkg, severity: via.severity, title: via.title, url: via.url });
  }
}

const origins = topLevelOrigins();
const failures = [];
for (const a of advisories.values()) {
  const allowed = ALLOWLIST[a.id];
  if (!allowed) {
    failures.push(`${a.severity} ${a.id} in ${a.pkg}: ${a.title} (${a.url})`);
    continue;
  }
  const from = originsOf(a.pkg, origins);
  const stray = [...from].filter((t) => t !== allowed.via);
  if (allowed.pkg !== a.pkg || from.size === 0 || stray.length) {
    failures.push(
      `${a.id} is allowlisted only through ${allowed.via}, but ${a.pkg} is reached from ${from.size ? [...from].join(", ") : "nothing in the lockfile"}`
    );
  } else {
    console.log(`allowed  ${a.severity} ${a.id} in ${a.pkg} (via ${allowed.via}): ${allowed.why}`);
  }
}
for (const id of Object.keys(ALLOWLIST)) {
  if (!advisories.has(id)) console.log(`notice   ${id} no longer reported; remove it from the allowlist`);
}

if (failures.length) {
  console.error(`\nDependency audit failed: ${failures.length} high/critical advisory(ies) not allowlisted:`);
  for (const f of failures) console.error(`  ${f}`);
  console.error("\nUpgrade the package (npm update <pkg>, or an `overrides` entry), or, if it truly cannot reach");
  console.error("production code, allowlist the advisory id here with the one package it arrives through.");
  process.exit(1);
}
console.log(`\nDependency audit clean: ${advisories.size} high/critical advisory(ies), all allowlisted.`);
