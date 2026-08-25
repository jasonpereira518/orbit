import { desc, eq, getTableColumns, getTableName, sql } from "drizzle-orm";
import { PgTable } from "drizzle-orm/pg-core";
import { getDb, rowsOf } from "@/db";
import * as schema from "@/db/schema";
import { adminAuditLog } from "@/db/schema";
import { num, toDate } from "@/lib/admin-metrics";
import { USAGE_EVENT_RETENTION_DAYS } from "@/lib/admin-health";

/**
 * What Orbit is exposed to, given what it stores.
 *
 * THE STRUCTURAL FACT THIS SECTION EXISTS FOR: most of Orbit's data is not about its users.
 * It is about third parties — contacts, recruiters — who never signed up, never agreed to
 * anything, and have no account through which to object. Names, employers, phone numbers,
 * and AI-written prose about people who do not know the product exists. That is the
 * liability a buyer's or a regulator's first question lands on, and until now it was
 * nowhere on the console.
 *
 * The machinery already existed and was verified: `exportAllData()` and `deleteAllData()`
 * give users self-serve export and erasure, `purgeUserData()` handles account deletion, and
 * the privacy and terms pages are live. What was missing is any way to see whether it
 * *works*.
 */

/**
 * Rows whose owning account no longer exists.
 *
 * DERIVED FROM THE SCHEMA, not from a hand-written list — the same technique
 * `scripts/smoke-purge.ts` uses, and for the same reason: a hand-maintained list has
 * exactly the blind spot of the code it is checking. Three tables have now reached
 * production user-scoped and unpurged (`outlook_connections`, `suggested_reminders`,
 * `recruiter_messages`), and each was invisible until something enumerated the schema.
 *
 * The smoke test catches this in CI against seeded data. This catches it in production
 * against real data, which is where a leak that predates the test still lives.
 *
 * `billing_events` is excluded by name: it is deliberately anonymised rather than deleted
 * on purge (financial records must survive a customer leaving), so its null `user_id` rows
 * are correct rather than orphaned.
 */
const ANONYMISED_ON_PURGE = new Set(["billing_events"]);

export type OrphanTable = { table: string; rows: number };

/** The user-scoped tables the sweep covers, derived from the schema rather than listed. */
function sweptTables(): string[] {
  const names: string[] = [];
  for (const value of Object.values(schema)) {
    if (!(value instanceof PgTable)) continue;
    if (!("userId" in getTableColumns(value))) continue;
    const name = getTableName(value);
    if (name === "user_settings" || ANONYMISED_ON_PURGE.has(name)) continue;
    names.push(name);
  }
  return names;
}

function orphanCountSql(table: string): string {
  return `SELECT '${table}' AS t, count(*) AS n FROM ${table} x
          WHERE x.user_id IS NOT NULL
            AND NOT EXISTS (
              SELECT 1 FROM user_settings s WHERE s.user_id = x.user_id
            )`;
}

export async function orphanRows(): Promise<OrphanTable[]> {
  const db = await getDb();
  const tables = sweptTables();
  if (tables.length === 0) return [];

  // ONE round trip, not one per table. There are 25 swept tables and on Neon HTTP every
  // statement is its own HTTPS request, so the loop this replaced was 25 sequential
  // network round trips on both /admin/health and /admin (via `decisionsWaiting`).
  // Same technique as `getDataQuality` in admin-product-health.ts.
  //
  // Table names are interpolated raw, which is safe *because they come from the schema*
  // rather than from a request — `sweptTables()` reads Drizzle's own table objects.
  try {
    const result = await db.execute(
      sql.raw(tables.map(orphanCountSql).join("\n UNION ALL "))
    );
    return rowsOf<{ t: string; n: number | string }>(result)
      .map((r) => ({ table: r.t, rows: num(r.n) }))
      .filter((r) => r.rows > 0)
      .sort((a, b) => b.rows - a.rows);
  } catch {
    // A single unreadable table fails the whole UNION, and a sweep that silently returns
    // nothing is indistinguishable from a clean database — which is the exact failure
    // `smoke-data-protection.ts` exists to catch. So fall back to asking table by table,
    // where one unreadable table only costs its own row.
    return orphanRowsPerTable(db, tables);
  }
}

async function orphanRowsPerTable(
  db: Awaited<ReturnType<typeof getDb>>,
  tables: string[]
): Promise<OrphanTable[]> {
  const out: OrphanTable[] = [];
  const counts = await Promise.all(
    tables.map(async (name) => {
      try {
        const result = await db.execute(sql.raw(orphanCountSql(name)));
        return { table: name, rows: num(rowsOf<{ n: number | string }>(result)[0]?.n) };
      } catch {
        // Not evidence of a leak; skip rather than reporting a false one.
        return null;
      }
    })
  );
  for (const c of counts) if (c && c.rows > 0) out.push(c);
  return out.sort((a, b) => b.rows - a.rows);
}

export type RetentionRule = {
  what: string;
  policy: string;
  rows: number | null;
  /** True where nothing expires it. Not necessarily wrong — but it should be a decision. */
  keptForever: boolean;
};

/**
 * What is kept, and for how long.
 *
 * Rendered so the answer is a stated policy rather than an accident. Contact data has no
 * retention rule at all, which is a defensible choice for a CRM — the whole product is
 * remembering people — but it is the sort of thing that should be chosen out loud, given
 * that the people being remembered did not agree to it.
 */
/**
 * Row counts for several tables in one round trip.
 *
 * Returns `null` for a table it could not read, which the callers render as "unknown"
 * rather than as zero — an unreadable table and an empty one are very different claims.
 */
async function countTables(
  db: Awaited<ReturnType<typeof getDb>>,
  tables: string[]
): Promise<Map<string, number | null>> {
  const out = new Map<string, number | null>(tables.map((t) => [t, null]));

  try {
    const result = await db.execute(
      sql.raw(
        tables
          .map((t) => `SELECT '${t}' AS t, count(*) AS n FROM ${t}`)
          .join("\n UNION ALL ")
      )
    );
    for (const r of rowsOf<{ t: string; n: number | string }>(result)) {
      out.set(r.t, num(r.n));
    }
    return out;
  } catch {
    // One missing table would otherwise blank every count on the screen.
    await Promise.all(
      tables.map(async (t) => {
        try {
          const r = await db.execute(sql.raw(`SELECT count(*) AS n FROM ${t}`));
          out.set(t, num(rowsOf<{ n: number | string }>(r)[0]?.n));
        } catch {
          out.set(t, null);
        }
      })
    );
    return out;
  }
}

export async function retentionPicture(): Promise<RetentionRule[]> {
  const db = await getDb();

  const counts = await countTables(db, [
    "contacts",
    "recruiter_messages",
    "chat_messages",
    "usage_events",
    "error_events",
    "billing_events",
  ]);
  const count = (table: string): number | null => counts.get(table) ?? null;

  return [
    {
      what: "Contacts and interactions",
      policy: "Kept until the user deletes them or their account",
      rows: count("contacts"),
      keptForever: true,
    },
    {
      what: "Recruiter messages",
      policy: "Kept until the user deletes them or their account",
      rows: count("recruiter_messages"),
      keptForever: true,
    },
    {
      what: "Chat transcripts",
      policy: "Kept until the user deletes them or their account",
      rows: count("chat_messages"),
      keptForever: true,
    },
    {
      what: "AI usage events",
      policy: `Pruned after ${USAGE_EVENT_RETENTION_DAYS} days`,
      rows: count("usage_events"),
      keptForever: false,
    },
    {
      what: "Error events",
      policy: "Pruned after 30 days",
      rows: count("error_events"),
      keptForever: false,
    },
    {
      what: "Billing events",
      policy: "Kept indefinitely, anonymised when the account is deleted",
      rows: count("billing_events"),
      keptForever: true,
    },
  ];
}

/** Someone who tried to reach the console and was refused. */
export type AccessDenial = {
  userId: string;
  at: Date | null;
  path: string | null;
};

/**
 * Failed attempts to reach the admin console.
 *
 * The gate answers 404 rather than 403 on purpose — a 403 confirms both that the surface
 * exists and that the caller found its path, which on a console with exactly one legitimate
 * user is pure information leak. The side effect was that an attempt left no trace at all.
 *
 * Recorded server-side; the response is unchanged. On a console with one legitimate user,
 * the second name in this list is worth knowing about.
 */
export async function recentAccessDenials(limit = 20): Promise<AccessDenial[]> {
  const db = await getDb();
  const rows = await db
    .select({
      userId: adminAuditLog.adminUserId,
      at: adminAuditLog.createdAt,
      detail: adminAuditLog.detail,
    })
    .from(adminAuditLog)
    .where(eq(adminAuditLog.action, "access.denied"))
    .orderBy(desc(adminAuditLog.createdAt))
    .limit(limit);

  return rows.map((r) => ({
    userId: r.userId,
    at: toDate(r.at),
    path: (r.detail as { path?: string } | null)?.path ?? null,
  }));
}

export type DataProtectionPicture = {
  orphans: OrphanTable[];
  retention: RetentionRule[];
  denials: AccessDenial[];
  /** Third-party records Orbit holds — the number the exposure question is really about. */
  thirdPartyRecords: number | null;
};

export async function getDataProtection(): Promise<DataProtectionPicture> {
  const db = await getDb();

  // All four in one wave. `thirdParty` used to be awaited before the others, which made
  // the cheapest query on the screen gate the three expensive ones behind it.
  const [thirdParty, orphans, retention, denials] = await Promise.all([
    db
      .execute(sql`SELECT count(*)::int AS n FROM contacts`)
      .then((r) => num(rowsOf<{ n: number }>(r)[0]?.n))
      .catch(() => null),
    orphanRows().catch(() => []),
    retentionPicture().catch(() => []),
    recentAccessDenials().catch(() => []),
  ]);

  return { orphans, retention, denials, thirdPartyRecords: thirdParty };
}
