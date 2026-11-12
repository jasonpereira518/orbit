/**
 * Golden (characterization) helpers for the PGlite-backed `*.test.ts` files.
 *
 * - `FROZEN_NOW` / `freezeClock()` pin `Date` (via node:test's mock timers) so code that calls
 *   `new Date()` / `Date.now()` is deterministic. Postgres' own `now()` is NOT frozen; values
 *   it produces fall inside the "real now" window and are normalized to `<db-now>`.
 * - `normalize()` turns a result into plain, stable JSON: uuids become `<id:N>` in order of
 *   first appearance, Maps/Sets/Dates become JSON, object keys are sorted.
 * - `expectGolden()` compares against a committed file; `UPDATE_GOLDEN=1` rewrites it.
 *
 * Import `scripts/smoke/_env` FIRST in every test file (strips DATABASE_URL and provider keys,
 * points PGlite at a throwaway directory) before importing anything that opens the database.
 */
// Local-noon / local-day logic exists in the code under test; pin the zone so goldens match on any machine.
process.env.TZ = "UTC";

import assert from "node:assert/strict";
import { mock } from "node:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** The instant every golden test believes it is. */
export const FROZEN_NOW = new Date("2026-09-15T12:00:00.000Z");
export const DAY_MS = 86_400_000;
export const daysAgo = (d: number) => new Date(FROZEN_NOW.getTime() - d * DAY_MS);
export const daysAhead = (d: number) => new Date(FROZEN_NOW.getTime() + d * DAY_MS);

// Captured at import time, before any mock, so DB-generated timestamps can be recognised.
const REAL_NOW_AT_IMPORT = Date.now();
const REAL_WINDOW_MS = 6 * 3_600_000;

export function freezeClock(at: Date = FROZEN_NOW): void {
  mock.timers.enable({ apis: ["Date"], now: at.getTime() });
}

const UUID_RE = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/g;

function dateToken(t: number): string {
  if (Math.abs(t - REAL_NOW_AT_IMPORT) < REAL_WINDOW_MS && Math.abs(t - FROZEN_NOW.getTime()) >= REAL_WINDOW_MS) {
    return "<db-now>";
  }
  return new Date(t).toISOString();
}

export function normalize(value: unknown, extraStrings: Record<string, string> = {}): unknown {
  const ids = new Map<string, string>();
  const idToken = (raw: string) => {
    const key = raw.toLowerCase();
    let tok = ids.get(key);
    if (!tok) {
      tok = `<id:${ids.size + 1}>`;
      ids.set(key, tok);
    }
    return tok;
  };
  const isoRe = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;
  const walk = (v: unknown): unknown => {
    if (v === null || v === undefined) return v === undefined ? null : v;
    if (v instanceof Date) return Number.isNaN(v.getTime()) ? "<invalid-date>" : dateToken(v.getTime());
    if (typeof v === "string") {
      if (isoRe.test(v)) return dateToken(Date.parse(v));
      let s = v;
      for (const [from, to] of Object.entries(extraStrings)) s = s.split(from).join(to);
      return s.replace(UUID_RE, idToken);
    }
    if (typeof v === "bigint") return Number(v);
    if (typeof v !== "object") return v;
    if (v instanceof Map) {
      return { "<map>": [...v.entries()].map(([k, val]) => [walk(k), walk(val)]) };
    }
    if (v instanceof Set) return { "<set>": [...v].map(walk) };
    if (Array.isArray(v)) return v.map(walk);
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v).sort()) {
      const r = (v as Record<string, unknown>)[k];
      if (typeof r === "function") continue;
      // `itemHash` digests a (randomly generated) contact id, so it differs per run.
      if (k === "itemHash" && typeof r === "string") {
        out[k] = "<hash>";
        continue;
      }
      out[k] = walk(r);
    }
    return out;
  };
  return walk(value);
}

/**
 * Compare `value` (after `normalize`) to `<test dir>/golden/<name>.json`.
 * `UPDATE_GOLDEN=1 npm run test:unit` rewrites the file.
 */
export function expectGolden(testFileUrl: string, name: string, value: unknown, extraStrings?: Record<string, string>): void {
  const dir = join(dirname(fileURLToPath(testFileUrl)), "golden");
  const file = join(dir, `${name}.json`);
  const actual = `${JSON.stringify(normalize(value, extraStrings), null, 2)}\n`;
  if (process.env.UPDATE_GOLDEN === "1" || !existsSync(file)) {
    if (process.env.UPDATE_GOLDEN !== "1") {
      assert.fail(`Missing golden ${file}. Run with UPDATE_GOLDEN=1 to create it.`);
    }
    mkdirSync(dir, { recursive: true });
    writeFileSync(file, actual);
    return;
  }
  rmSync(`${file}.actual`, { force: true });
  const expected = readFileSync(file, "utf8");
  if (actual !== expected) {
    // Keep the failure short (the payloads are large); diff the two files to see the change.
    writeFileSync(`${file}.actual`, actual);
    assert.fail(`golden mismatch: ${file}\n  diff ${file} ${file}.actual\n  UPDATE_GOLDEN=1 to accept`);
  }
}

/** Order rows deterministically by a key function (ids are random, so never sort by id alone). */
export function sortBy<T>(rows: readonly T[], key: (r: T) => string): T[] {
  return [...rows].sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));
}
