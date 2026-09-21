/**
 * Guards `createSettler` (`src/lib/settle-once.ts`) — the promise wrapper that gives a
 * callback-driven browser API (the Google Picker, first) exactly-once settlement even when
 * the callback fires twice or never fires at all.
 *
 * Pure: no network, no database. Run: npx tsx scripts/smoke-settle-once.ts
 */
import { createSettler } from "../src/lib/settle-once";

let failures = 0;
function check(name: string, cond: boolean, extra?: unknown) {
  if (cond) {
    console.log(`  ok   ${name}`);
    return;
  }
  failures++;
  console.log(`  FAIL ${name}`, extra ?? "");
}

async function main() {
  console.log("createSettler");

  {
    const s = createSettler<number>();
    check("not settled before either is called", !s.settled());
    s.resolve(1);
    check("settled after resolve", s.settled());
    check("resolves to the given value", (await s.promise) === 1);
  }

  {
    // A second resolve after the first is a silent no-op — the promise keeps its first value.
    const s = createSettler<number>();
    s.resolve(1);
    s.resolve(2);
    check("a second resolve does not override the first", (await s.promise) === 1);
  }

  {
    // A reject after an earlier resolve must not turn a settled promise into a rejection —
    // exactly the shape of a Picker callback firing PICKED and then, moments later, an
    // unrelated action the caller treats as a failure.
    const s = createSettler<number>();
    s.resolve(1);
    s.reject(new Error("too late"));
    check("a reject after resolve is ignored", (await s.promise) === 1);
  }

  {
    const err = new Error("boom");
    const s = createSettler<number>();
    s.reject(err);
    check("settled after reject", s.settled());
    let caught: unknown;
    try {
      await s.promise;
    } catch (e) {
      caught = e;
    }
    check("rejects with the given error", caught === err);
  }

  {
    // A resolve after an earlier reject must not turn a settled rejection into a resolution —
    // the mirror case of a timeout firing first and a late callback arriving after.
    const s = createSettler<number>();
    const err = new Error("first");
    s.reject(err);
    s.resolve(99);
    let caught: unknown;
    try {
      await s.promise;
    } catch (e) {
      caught = e;
    }
    check("a resolve after reject is ignored", caught === err);
  }

  if (failures > 0) {
    console.error(`\n${failures} check(s) failed.`);
    process.exit(1);
  }
  console.log("\nAll settle-once checks passed.");
  process.exit(0);
}

main();
