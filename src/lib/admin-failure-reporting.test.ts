import "../../scripts/smoke/_env";
import assert from "node:assert/strict";
import { afterEach, before, beforeEach, describe, it, mock } from "node:test";
import { sql } from "drizzle-orm";
import { getDb } from "@/db";
import { getAccountAlerts } from "@/lib/account-health";
import { getSystemIssues } from "@/lib/admin-system";
import { checkHealth } from "@/lib/health";

/**
 * A failed admin read keeps its fallback (0 / [] / null) but must leave an
 * `[orbit:admin.*]` line behind, so a dead query is not read as a healthy zero.
 */
let warn: ReturnType<typeof mock.method>;
const warned = () => warn.mock.calls.map((c) => String(c.arguments[0]));

// The database is a throwaway PGlite (see _env), so breaking it for this file is safe. Dropping
// a table is a real failing query, which a mocked `db.execute` is not: `getDb()` rebuilds its
// wrapper on every call in dev.
before(async () => {
  const db = await getDb();
  await db.execute(sql`DROP TABLE IF EXISTS outlook_connections CASCADE`);
  await db.execute(sql`DROP TABLE IF EXISTS contact_embeddings CASCADE`);
});

beforeEach(() => {
  warn = mock.method(console, "warn", () => {});
});
afterEach(() => mock.restoreAll());

describe("admin failure reporting", () => {
  it("getSystemIssues: failed query still returns zeros and logs", async () => {
    const issues = await getSystemIssues();
    assert.equal(issues.syncFailing, 0);
    assert.equal(issues.needsReauth, 0);
    assert.ok(warned().some((l) => /^\[orbit:admin\.system\.connection-health\] ref=[0-9a-f]{8}$/.test(l)), warned().join("|"));
  });

  it("getAccountAlerts: failed load still returns [] and logs", async () => {
    const alerts = await getAccountAlerts("user_missing");
    assert.deepEqual(alerts, []);
    assert.ok(warned().some((l) => /^\[orbit:admin\.account-health\.account-alerts\] ref=[0-9a-f]{8} user=user_missing$/.test(l)), warned().join("|"));
  });

  it("checkHealth: a failed DB probe keeps its reason and logs", async () => {
    const report = await checkHealth({
      deep: false,
      probeDb: async () => {
        throw new Error("ECONNREFUSED");
      },
    });
    assert.equal(report.status, "down");
    assert.equal(report.db.reason, "db_error");
    assert.ok(warned().some((l) => l.startsWith("[orbit:admin.health.db-probe] ref=")), warned().join("|"));
  });

  it("checkHealth deep: a failed section reads as null and logs", async () => {
    const report = await checkHealth({
      deep: true,
      probeDb: async () => ({ recorded: Number.MAX_SAFE_INTEGER }),
      cronHealth: async () => {
        throw new Error("cron read failed");
      },
    });
    assert.ok(report);
    assert.ok(warned().some((l) => l.startsWith("[orbit:admin.health.section] ref=")), warned().join("|"));
  });
});
