/**
 * `deriveSyncState`: what a connection row says about its first sync.
 *
 * The branch that matters is "done" versus "still working". A run that ran out of budget
 * mid-address-book schedules itself for the moment it started, which sorts BEFORE the
 * `lastSyncedAt` it stamps on exit. Treating any stamped `lastSyncedAt` as "done" would tell
 * someone with a 5,000-contact book that syncing finished after the first page.
 */
import "./smoke/_env";
import { run } from "./smoke/_env";
import { deriveSyncState, type SyncRowState } from "../src/lib/sync-progress";

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

const T0 = new Date("2026-09-29T12:00:00Z");
const at = (ms: number) => new Date(T0.getTime() + ms);
const row = (over: Partial<SyncRowState>): SyncRowState => ({
  status: "active",
  syncStatus: "idle",
  lastSyncedAt: null,
  nextSyncAt: null,
  syncError: null,
  ...over,
});

run(async () => {
  console.log("before and during the first run");
  check("armed, never run -> queued", deriveSyncState(row({ nextSyncAt: T0 })) === "queued");
  check(
    "holding the lease -> syncing",
    deriveSyncState(row({ syncStatus: "syncing", nextSyncAt: T0 })) === "syncing"
  );

  console.log("\nafter a run");
  check(
    "finished: next run is a sync interval ahead of the stamp -> done",
    deriveSyncState(row({ lastSyncedAt: at(5_000), nextSyncAt: at(30 * 60_000) })) === "done"
  );
  check(
    "ran out of budget: next run is due at the run's START, before the stamp -> still syncing",
    deriveSyncState(row({ lastSyncedAt: at(60_000), nextSyncAt: at(0) })) === "syncing"
  );

  console.log("\nfailure and pause");
  check(
    "a needs_reauth grant -> error",
    deriveSyncState(row({ status: "needs_reauth", lastSyncedAt: at(1), nextSyncAt: null })) === "error"
  );
  check(
    "a failing run -> error",
    deriveSyncState(row({ syncStatus: "error", syncError: "boom", nextSyncAt: at(60_000) })) === "error"
  );
  check(
    "disarmed with nothing ever synced (no next run) -> error, not queued",
    deriveSyncState(row({ lastSyncedAt: null, nextSyncAt: null })) === "error"
  );
  check(
    "disarmed after a good run -> error, not done",
    deriveSyncState(row({ lastSyncedAt: at(1), nextSyncAt: null })) === "error"
  );
  check(
    "the person paused meetings -> paused, even with a dead grant flag elsewhere",
    deriveSyncState(row({ syncStatus: "paused", status: "needs_reauth" })) === "paused"
  );

  if (failures > 0) {
    console.error(`\n${failures} check(s) failed.`);
    process.exit(1);
  }
  console.log("\nAll sync progress checks passed.");
});
