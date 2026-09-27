/**
 * The missed-webhook sweep purges only accounts Clerk no longer has, only once they have been
 * idle a week, never non-Clerk ids, and stops cold when Clerk says "everyone is gone".
 * Run: npx tsx scripts/smoke-clerk-orphan-sweep.ts
 */
import "./smoke/_env";
import { run } from "./smoke/_env";

import { inArray, like } from "drizzle-orm";
import { getDb } from "../src/db";
import { userSettings } from "../src/db/schema";
import { sweepOrphanedAccounts } from "../src/lib/clerk-orphan-sweep";

const NOW = new Date("2026-09-20T03:00:00Z");
const OLD = new Date("2026-09-01T00:00:00Z");
const RECENT = new Date("2026-09-19T00:00:00Z");

function check(label: string, ok: boolean, detail?: string) {
  if (!ok) throw new Error(`${label} failed${detail ? `: ${detail}` : ""}`);
  console.log(`  ok  ${label}`);
}

async function exists(userId: string) {
  const db = await getDb();
  return (await db.select().from(userSettings).where(inArray(userSettings.userId, [userId]))).length === 1;
}

async function main() {
  const db = await getDb();
  await db.delete(userSettings).where(like(userSettings.userId, "user_smoke_orphan%"));
  await db.insert(userSettings).values([
    { userId: "user_smoke_orphan_alive", lastActiveAt: OLD },
    { userId: "user_smoke_orphan_gone", lastActiveAt: OLD },
    { userId: "user_smoke_orphan_gone_recent", lastActiveAt: RECENT },
    { userId: "demo-user-smoke-orphan", lastActiveAt: OLD },
  ]);
  const alive = new Set(["user_smoke_orphan_alive"]);
  const asked: string[][] = [];
  const result = await sweepOrphanedAccounts({
    now: NOW,
    lookup: async (ids) => {
      asked.push(ids);
      return new Set(ids.filter((id) => alive.has(id)));
    },
  });
  check("the missing, idle Clerk account is purged", !(await exists("user_smoke_orphan_gone")) && result.purged === 1, JSON.stringify(result));
  check("a live account is untouched", await exists("user_smoke_orphan_alive"));
  check("a recently active account is not even asked about", await exists("user_smoke_orphan_gone_recent") && !asked.flat().includes("user_smoke_orphan_gone_recent"));
  check("a non-Clerk id is never considered", await exists("demo-user-smoke-orphan") && !asked.flat().includes("demo-user-smoke-orphan"));
  check("every lookup batch is at most 100 ids", asked.every((b) => b.length <= 100));

  console.log("\nClerk reporting everyone gone");
  const many = Array.from({ length: 12 }, (_, i) => ({ userId: `user_smoke_orphan_bulk_${i}`, lastActiveAt: OLD }));
  await db.insert(userSettings).values(many);
  const aborted = await sweepOrphanedAccounts({ now: NOW, lookup: async () => new Set() });
  check("the sweep aborts", aborted.aborted === true && aborted.purged === 0, JSON.stringify(aborted));
  check("...and purges nobody", await exists("user_smoke_orphan_bulk_0"));

  console.log("\nThe per-run cap");
  const capped = await sweepOrphanedAccounts({
    now: NOW,
    maxPurges: 2,
    lookup: async (ids) => {
      const gone = ["user_smoke_orphan_bulk_0", "user_smoke_orphan_bulk_1", "user_smoke_orphan_bulk_2"];
      return new Set(ids.filter((id) => !gone.includes(id)));
    },
  });
  check("no more than maxPurges accounts are purged in one run", capped.purged === 2 && capped.orphaned === 3, JSON.stringify(capped));

  await db.delete(userSettings).where(like(userSettings.userId, "user_smoke_orphan%"));
  await db.delete(userSettings).where(inArray(userSettings.userId, ["demo-user-smoke-orphan"]));
  console.log("\nAll orphan-sweep checks passed.");
}

run(main);
