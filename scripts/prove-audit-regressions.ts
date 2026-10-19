/**
 * Proves the audit's regression tests catch what they claim (FIX_PLAN Phase 4.6): each stress
 * proof in `stress-tests/` must FAIL with its own findings on the commit before the audit's
 * fixes, and pass on this one. A test that passes on the broken code proves nothing.
 *
 * It checks out the pre-fix commit into a throwaway git worktree, copies today's
 * `stress-tests/` into it, runs every script under STRESS_STRICT, and compares the `BUG` ids
 * printed with the ones each script exists to prove. Then it runs the same scripts here,
 * where every one must pass. No network; each run uses its own throwaway PGlite directory.
 *
 *   npx tsx scripts/prove-audit-regressions.ts [--base <commit>]   (default: eb5d69d)
 *
 * Manual tier: it needs git history back to the base commit and takes about a minute.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

/** What each stress script proves on the pre-fix code. `net-guard-edge` proved nothing broken. */
const EXPECTED: Record<string, string[]> = {
  "input-extremes": ["EC-DATE-1", "EC-DATE-2", "EC-LEN-1", "EC-LEN-2", "EC-LEN-3", "EC-UNI-1", "EC-URL-1", "AZ-OPT-1"],
  "concurrency-races": ["RACE-CAP-1"],
  "resilience-repros": ["DI-PAGE-NULL", "DI-DUP-CREATE", "DI-IMPORT-DOUBLE", "DI-CAPTURE-PARTIAL", "INJ-CSV", "INJ-DOCX-BOMB"],
  "recurrence-edge": ["REC-3"],
  "net-guard-edge": [],
};

const args = process.argv.slice(2);
const base = args.includes("--base") ? args[args.indexOf("--base") + 1]! : "eb5d69d";
const root = resolve(".");

function runStress(cwd: string, name: string): { code: number; bugs: Set<string> } {
  const res = spawnSync("npx", ["tsx", `stress-tests/${name}.ts`], {
    cwd,
    env: { ...process.env, STRESS_STRICT: "1", FORCE_COLOR: "0" },
    encoding: "utf8",
    timeout: 5 * 60_000,
  });
  const out = `${res.stdout ?? ""}${res.stderr ?? ""}`;
  const bugs = new Set([...out.matchAll(/^\s*BUG\s+\[([A-Z0-9-]+)\]/gm)].map((m) => m[1]!));
  return { code: res.status ?? 1, bugs };
}

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

const dir = mkdtempSync(join(tmpdir(), "orbit-prefix-"));
try {
  execFileSync("git", ["worktree", "add", "--detach", dir, base], { stdio: "ignore" });
  symlinkSync(join(root, "node_modules"), join(dir, "node_modules"));
  rmSync(join(dir, "stress-tests"), { recursive: true, force: true });
  cpSync(join(root, "stress-tests"), join(dir, "stress-tests"), { recursive: true });

  console.log(`On ${base} (before the fixes) every proof must fail with its findings…`);
  for (const [name, expected] of Object.entries(EXPECTED)) {
    const { code, bugs } = runStress(dir, name);
    const missing = expected.filter((id) => !bugs.has(id));
    if (expected.length === 0) {
      check(`${name}: nothing to prove, and it ran`, code === 0, `exit ${code}`);
    } else {
      check(`${name}: fails, with every finding it proves`, code !== 0 && missing.length === 0,
        missing.length ? `missing ${missing.join(", ")}` : `exit ${code}`);
    }
  }

  console.log("\nOn this commit every proof must pass…");
  for (const name of Object.keys(EXPECTED)) {
    const { code, bugs } = runStress(root, name);
    check(`${name}: passes`, code === 0 && bugs.size === 0, bugs.size ? `still ${[...bugs].join(", ")}` : `exit ${code}`);
  }
} finally {
  if (existsSync(dir)) {
    try {
      execFileSync("git", ["worktree", "remove", "--force", dir], { stdio: "ignore" });
    } catch {
      rmSync(dir, { recursive: true, force: true });
    }
  }
}

if (failures) {
  console.error(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log("\nEvery regression proof fails before its fix and passes after it.");
