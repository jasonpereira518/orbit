/** Shared helpers for the latency harness: percentiles, timing, output files. */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export function percentile(xs, p) {
  if (!xs.length) return null;
  const s = [...xs].filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (!s.length) return null;
  const idx = Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1));
  return s[idx];
}

export const median = (xs) => percentile(xs, 50);
export const r1 = (x) => (x == null ? null : Math.round(x * 10) / 10);
export const r0 = (x) => (x == null ? null : Math.round(x));

export function summary(xs) {
  return { n: xs.length, p50: r0(percentile(xs, 50)), p95: r0(percentile(xs, 95)), p99: r0(percentile(xs, 99)), min: r0(Math.min(...xs)), max: r0(Math.max(...xs)) };
}

export function flag(name, fallback) {
  const hit = process.argv.slice(2).find((a) => a.startsWith(`--${name}=`));
  if (hit) return hit.slice(name.length + 3);
  return process.argv.includes(`--${name}`) ? "1" : fallback;
}

export function writeJson(path, data) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(data, null, 2));
  console.log(`wrote ${path}`);
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Device profiles. Values follow Lighthouse's "mobile slow 4G" and an unthrottled desktop. */
export const PROFILES = {
  desktop: {
    viewport: { width: 1366, height: 850 },
    mobile: false,
    network: null,
    cpuRate: 1,
  },
  mobile4g: {
    viewport: { width: 390, height: 844 },
    mobile: true,
    deviceScaleFactor: 3,
    // Lighthouse mobile preset: 150 ms RTT, 1.6 Mbps down, 750 Kbps up, 4x CPU slowdown.
    network: { latency: 150, downloadThroughput: (1.6 * 1024 * 1024) / 8, uploadThroughput: (750 * 1024) / 8 },
    cpuRate: 4,
  },
};

/**
 * Chromium for Playwright. Playwright wants the exact build its version pins; when that is
 * not installed (this machine has chromium-1194 under /opt/pw-browsers for Playwright 1.63,
 * which pins 1243), fall back to the installed build or CHROMIUM_PATH.
 */
export function chromiumExecutable(chromium) {
  const env = process.env.CHROMIUM_PATH;
  if (env && existsSync(env)) return env;
  try { const p = chromium.executablePath(); if (p && existsSync(p)) return p; } catch {}
  const root = process.env.PLAYWRIGHT_BROWSERS_PATH || "/opt/pw-browsers";
  for (const c of [`${root}/chromium`, `${root}/chromium-1194/chrome-linux/chrome`]) if (existsSync(c)) return c;
  return undefined;
}
