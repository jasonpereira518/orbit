/**
 * `kickSyncPass`: the "sync now" nudge the OAuth callbacks fire after connecting.
 *
 * What matters is the contract the callbacks lean on: it POSTs to the scheduler route the
 * cron uses, a lost or refused kick is a `false` and never a throw (a callback that throws
 * here would turn a successful connect into an error redirect), and a timeout is NOT a
 * failure, because `/api/sync/run` works inline and a slow answer means it is busy.
 */
import "./smoke/_env";
import { run } from "./smoke/_env";
import { kickSyncPass } from "../src/lib/sync-kick";

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

run(async () => {
  console.log("a reachable scheduler");
  const calls: Array<{ path: string; method?: string }> = [];
  const ok = await kickSyncPass(async (path, init) => {
    calls.push({ path, method: init?.method });
    return new Response("{}", { status: 200 });
  });
  check("resolves true", ok === true);
  check(
    "POSTs to the cron's own route",
    calls.length === 1 && calls[0].path === "/api/sync/run" && calls[0].method === "POST",
    JSON.stringify(calls)
  );

  console.log("\na refused kick (wrong or missing secret)");
  const refused = await kickSyncPass(async () => new Response("no", { status: 401 }));
  check("resolves false rather than throwing", refused === false);

  console.log("\na timeout means the pass is running, not down");
  const timedOut = await kickSyncPass(async () => {
    const err = new Error("The operation was aborted due to timeout");
    err.name = "TimeoutError";
    throw err;
  });
  check("counts as reached", timedOut === true);

  console.log("\na network failure never escapes");
  const failed = await kickSyncPass(async () => {
    throw new Error("connect ECONNREFUSED");
  });
  check("resolves false", failed === false);

  if (failures > 0) {
    console.error(`\n${failures} check(s) failed.`);
    process.exit(1);
  }
  console.log("\nAll sync kick checks passed.");
});
