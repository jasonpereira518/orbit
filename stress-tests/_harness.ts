/**
 * Shared preamble for the stress tests. Re-uses the smoke suite's `_env` so every script
 * here runs against a throwaway PGlite directory with DATABASE_URL and every billable
 * provider key deleted — exactly the same safety net `scripts/run-smoke.ts` enforces.
 *
 *   npx tsx stress-tests/<name>.ts
 *
 * Every script prints one line per check and exits non-zero when any check fails. A check
 * labelled `BUG` is a finding this audit is proving (it is EXPECTED to fail on the current
 * code); `ok` lines are behaviour that held. The summary at the end separates the two so a
 * red run is a list of confirmed findings, not a broken harness.
 */
import "../scripts/smoke/_env";
export { run } from "../scripts/smoke/_env";

export type Outcome = { label: string; ok: boolean; detail?: string; bug?: boolean };
const outcomes: Outcome[] = [];

/** A property that must hold. */
export function check(label: string, ok: boolean, detail?: string) {
  outcomes.push({ label, ok, detail });
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${label}${detail ? ` — ${trim(detail)}` : ""}`);
}

/**
 * A finding under proof: `holds` is the SECURE/CORRECT behaviour. When it is false the
 * finding is confirmed, printed as `BUG`, and counted separately from a harness failure.
 */
export function finding(id: string, label: string, holds: boolean, detail?: string) {
  outcomes.push({ label: `${id} ${label}`, ok: holds, detail, bug: !holds });
  console.log(`  ${holds ? "ok  " : "BUG "}  [${id}] ${label}${detail ? ` — ${trim(detail)}` : ""}`);
}

export async function rejects(fn: () => Promise<unknown>): Promise<{ threw: boolean; error: unknown }> {
  try {
    await fn();
    return { threw: false, error: null };
  } catch (error) {
    return { threw: true, error };
  }
}

export function errorText(e: unknown): string {
  return e instanceof Error ? `${e.name}: ${e.message}` : String(e);
}

function trim(s: string) {
  return s.replace(/\s+/g, " ").slice(0, 220);
}

export function summary(): void {
  const bugs = outcomes.filter((o) => o.bug);
  const failed = outcomes.filter((o) => !o.ok && !o.bug);
  console.log("");
  console.log(`${outcomes.length} checks: ${outcomes.filter((o) => o.ok).length} held, ${bugs.length} findings confirmed, ${failed.length} harness failures`);
  for (const b of bugs) console.log(`  BUG  ${b.label}`);
  if (failed.length) process.exitCode = 1;
}
