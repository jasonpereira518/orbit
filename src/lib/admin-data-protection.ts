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

export async function orphanRows(): Promise<OrphanTable[]> {
  const db = await getDb();
  const out: OrphanTable[] = [];

  for (const value of Object.values(schema)) {
    if (!(value instanceof PgTable)) continue;
    const columns = getTableColumns(value);
    if (!("userId" in columns)) continue;

    const name = getTableName(value);
    if (name === "user_settings" || ANONYMISED_ON_PURGE.has(name)) continue;

    try {
      const result = await db.execute(
        sql.raw(
          `SELECT count(*)::int AS n FROM ${name} t
           WHERE t.user_id IS NOT NULL
             AND NOT EXISTS (
               SELECT 1 FROM user_settings s WHERE s.user_id = t.user_id
             )`
        )
      );
      const rows = num(rowsOf<{ n: number }>(result)[0]?.n);
      if (rows > 0) out.push({ table: name, rows });
    } catch {
      // A table the query cannot read is not evidence of a leak; skip rather than
      // reporting a false one.
    }
  }

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
export async function retentionPicture(): Promise<RetentionRule[]> {
  const db = await getDb();

  const count = async (table: string): Promise<number | null> => {
    try {
      const r = await db.execute(sql.raw(`SELECT count(*)::int AS n FROM ${table}`));
      return num(rowsOf<{ n: number }>(r)[0]?.n);
    } catch {
      return null;
    }
  };

  return [
    {
      what: "Contacts and interactions",
      policy: "Kept until the user deletes them or their account",
      rows: await count("contacts"),
      keptForever: true,
    },
    {
      what: "Recruiter messages",
      policy: "Kept until the user deletes them or their account",
      rows: await count("recruiter_messages"),
      keptForever: true,
    },
    {
      what: "Chat transcripts",
      policy: "Kept until the user deletes them or their account",
      rows: await count("chat_messages"),
      keptForever: true,
    },
    {
      what: "AI usage events",
      policy: `Pruned after ${USAGE_EVENT_RETENTION_DAYS} days`,
      rows: await count("usage_events"),
      keptForever: false,
    },
    {
      what: "Error events",
      policy: "Pruned after 30 days",
      rows: await count("error_events"),
      keptForever: false,
    },
    {
      what: "Billing events",
      policy: "Kept indefinitely, anonymised when the account is deleted",
      rows: await count("billing_events"),
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

  const thirdParty = await db
    .execute(sql`SELECT count(*)::int AS n FROM contacts`)
    .then((r) => num(rowsOf<{ n: number }>(r)[0]?.n))
    .catch(() => null);

  const [orphans, retention, denials] = await Promise.all([
    orphanRows().catch(() => []),
    retentionPicture().catch(() => []),
    recentAccessDenials().catch(() => []),
  ]);

  return { orphans, retention, denials, thirdPartyRecords: thirdParty };
}
