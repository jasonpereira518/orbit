/**
 * The `check()` / `rejects()` pair most smoke scripts define for themselves, in one place.
 *
 *   const t = checker();
 *   t.check("refuses a foreign id", result === null);
 *   await t.rejects("throws on a bad token", () => verify("nope"));
 *   t.done("export smoke tests");   // exits 1 on any FAIL
 *
 * Known bugs. A defect found while writing tests is documented, not fixed, by a
 * `scripts/smoke-bug-*.ts` script in the manifest's `bug` tier:
 *
 *   t.knownBug("BUG-3: export does not neutralise formulas", cell.startsWith("'="));
 *
 * `knownBug` asserts the CORRECT behaviour, so it genuinely fails while the bug is there,
 * printing `BUG ` instead of `FAIL`. `done()` then exits with EXIT_KNOWN_BUG (3) when the
 * only failures are known bugs, and 1 when an ordinary check failed too — so
 * `run-smoke --bugs` can tell "still broken, as documented" (expected) from "fixed" (exit 0:
 * promote the script to an ordinary tier) and from "broke in some other way" (exit 1).
 */
export const EXIT_KNOWN_BUG = 3;

export function checker() {
  let failures = 0;
  const bugs: string[] = [];
  let finished = false;

  // Node exits 0 when the event loop empties, even with `main()` still awaiting a promise
  // that will never settle (a hung mock, an unref'd timer). Without this, a script that
  // stalls halfway through reads as a pass with half its checks never run.
  process.on("exit", (code) => {
    if (finished || code !== 0) return;
    console.error("\nFAIL  the script exited before done() — something it awaited never settled");
    process.exitCode = 1;
  });

  function check(label: string, ok: boolean, detail = ""): boolean {
    console.log(`  ${ok ? "ok  " : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
    if (!ok) failures++;
    return ok;
  }

  function knownBug(label: string, correctBehaviourHolds: boolean, detail = ""): boolean {
    if (correctBehaviourHolds) {
      console.log(`  FIXED ${label} — no longer reproduces`);
      return true;
    }
    console.log(`  BUG   ${label}${detail ? ` — ${detail}` : ""}`);
    bugs.push(label);
    return false;
  }

  async function rejects(label: string, fn: () => unknown, expect?: (e: unknown) => boolean): Promise<boolean> {
    try {
      await fn();
      return check(label, false, "did not throw");
    } catch (error) {
      return check(label, expect ? expect(error) : true, error instanceof Error ? error.message : String(error));
    }
  }

  function done(name: string): never {
    finished = true;
    if (failures > 0) {
      console.error(`\n${name}: ${failures} check(s) failed${bugs.length ? `, plus ${bugs.length} known bug(s)` : ""}`);
      process.exit(1);
    }
    if (bugs.length > 0) {
      console.error(`\n${name}: ${bugs.length} known bug(s) still reproduce:`);
      for (const b of bugs) console.error(`  - ${b}`);
      process.exit(EXIT_KNOWN_BUG);
    }
    console.log(`\n${name} passed`);
    process.exit(0);
  }

  return {
    check,
    knownBug,
    rejects,
    done,
    get failures() {
      return failures;
    },
  };
}
