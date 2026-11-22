/**
 * The save lock behind `useGuardedTransition` and `useSingleFlight`: while one run is in flight,
 * a second is refused at once, from any trigger, and it lets go on every way a run can end.
 *
 * Pure — the lock is `createSingleFlight`, free of React.
 *
 * Run: npx tsx scripts/smoke-single-flight.ts
 */
import { createSingleFlight } from "../src/lib/single-flight";

let failures = 0;
function check(label: string, ok: boolean, detail?: string) {
  if (ok) {
    console.log(`  ok  ${label}`);
    return;
  }
  failures++;
  console.log(`  FAIL ${label}${detail ? `: ${detail}` : ""}`);
}
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 5));

async function main() {
  console.log("A second call while one is in flight");
  {
    const flight = createSingleFlight();
    let runs = 0;
    let release!: () => void;
    const slow = () =>
      new Promise<void>((resolve) => {
        runs++;
        release = resolve;
      });
    flight.run(slow);
    check("is refused synchronously, before anything settles", flight.run(slow) === undefined && runs === 1, `runs ${runs}`);
    check("the lock reports busy", flight.busy);
    release();
    await tick();
    check("and the lock lets go once the promise resolves", !flight.busy);
    flight.run(slow);
    check("so the next save runs", runs === 2);
    release();
    await tick();
  }

  console.log("\nTwo triggers of one save (Enter, then blur)");
  {
    const flight = createSingleFlight();
    let saves = 0;
    const save = () => {
      saves++;
      return new Promise<void>((resolve) => setTimeout(resolve, 20));
    };
    flight.run(save); // Enter
    flight.run(save); // the blur that follows it
    await new Promise((resolve) => setTimeout(resolve, 40));
    check("saves once", saves === 1, `saves ${saves}`);
  }

  console.log("\nEvery way a run ends releases the lock");
  {
    const flight = createSingleFlight();
    flight.run(() => 1);
    check("a synchronous return", !flight.busy);

    let threw = false;
    try {
      flight.run(() => {
        throw new Error("boom");
      });
    } catch {
      threw = true;
    }
    check("a synchronous throw, which is also rethrown to the caller", threw && !flight.busy);

    const failing = flight.run(() => Promise.reject(new Error("rejected")));
    check("a rejecting promise holds the lock while it is pending", flight.busy);
    await failing?.catch(() => {});
    await tick();
    check("and releases it on rejection, so a failed save can be retried", !flight.busy);
    check("the rejection still reaches the caller", failing instanceof Promise);

    let ran = false;
    flight.run(() => {
      ran = true;
    });
    check("the next call after a failure runs", ran);
  }

  console.log("\nWhat the caller gets back");
  {
    const flight = createSingleFlight();
    check("the value, when it runs", flight.run(() => 42) === 42);
    const p = Promise.resolve("x");
    check("the very same promise, untouched", flight.run(() => p) === p);
    await tick();
  }

  if (failures > 0) {
    console.log(`\n${failures} check(s) failed`);
    process.exit(1);
  }
  console.log("\nsmoke-single-flight: all checks passed");
  process.exit(0);
}
main();
