/**
 * One-off: mark the operator's own accounts `internal`, so no dashboard counts them.
 *
 * WHY. Every product and revenue aggregate leaves out `internal` and `tester` accounts
 * (`internalAccountSql` in `src/lib/analytics-internal.ts`). That predicate already honours
 * `ADMIN_USER_IDS` and `DEMO_ACCOUNT_USER_ID` from the environment, but env ids are invisible
 * in the database: a read that cannot see the environment (a SQL console, a notebook, an
 * export) still counts them. This writes the same fact into `user_settings.account_kind` once,
 * so the label travels with the row. From here on the admin user page changes a kind with a
 * reason and an audit row (`setAccountKindAction`).
 *
 * Run (against whichever database `DATABASE_URL` points at, so check it first):
 *   npx tsx scripts/seed-account-kind.ts --dry-run   # counts only, writes nothing
 *   npx tsx scripts/seed-account-kind.ts
 *
 * WHAT IT TOUCHES. Only accounts that already exist, and only those with no kind yet: an
 * account an operator has already marked `tester` or `internal` is left exactly as it is. It
 * never creates a row (an id with no account is counted, not invented) and it is safe to run
 * again. It prints COUNTS ONLY, never the ids it read from the environment, and writes one
 * summary row to `admin_audit_log` with the same counts.
 */
import { config } from "dotenv";
config({ path: ".env.local" });
config();

import { and, inArray, isNull } from "drizzle-orm";
import { getDb } from "../src/db";
import { userSettings } from "../src/db/schema";
import { adminUserIds } from "../src/lib/admin";
import { recordAdminAction } from "../src/lib/admin-audit";
import { getShowcaseAccountId } from "../src/lib/demo-account";

export type SeedAccountKindResult = {
  /** Distinct ids named by `ADMIN_USER_IDS` and `DEMO_ACCOUNT_USER_ID` (the demo placeholder excluded). */
  named: number;
  /** Of those, how many have no account row here yet. */
  withoutAccount: number;
  /** Already carry a kind (internal or tester), left alone. */
  alreadyMarked: number;
  /** Marked `internal` by this run, or that WOULD be, under `--dry-run`. */
  marked: number;
};

export async function seedAccountKinds(opts: { dryRun?: boolean } = {}): Promise<SeedAccountKindResult> {
  const ids = new Set(adminUserIds());
  const showcase = getShowcaseAccountId();
  if (showcase) ids.add(showcase);
  // The shared local-dev account is not a real person's id and must never be labelled.
  ids.delete("demo-user");
  const named = [...ids];
  if (named.length === 0) return { named: 0, withoutAccount: 0, alreadyMarked: 0, marked: 0 };

  const db = await getDb();
  const rows = await db
    .select({ userId: userSettings.userId, kind: userSettings.accountKind })
    .from(userSettings)
    .where(inArray(userSettings.userId, named));
  const todo = rows.filter((r) => r.kind === null).map((r) => r.userId);

  if (todo.length > 0 && !opts.dryRun) {
    await db
      .update(userSettings)
      .set({ accountKind: "internal", updatedAt: new Date() })
      // The kind is re-checked in SQL: an operator marking an account between the read and
      // this write must not be overwritten.
      .where(and(inArray(userSettings.userId, todo), isNull(userSettings.accountKind)));
  }

  const result = {
    named: named.length,
    withoutAccount: named.length - rows.length,
    alreadyMarked: rows.length - todo.length,
    marked: todo.length,
  };
  if (!opts.dryRun && result.marked > 0) {
    await recordAdminAction({
      adminUserId: "script:seed-account-kind",
      action: "account_kind.seed",
      resourceType: "user_settings",
      detail: result,
      reason: "One-off seed: ADMIN_USER_IDS and DEMO_ACCOUNT_USER_ID marked internal.",
    });
  }
  return result;
}

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  const r = await seedAccountKinds({ dryRun });
  console.log(
    `${dryRun ? "[dry run] " : ""}${r.named} account id(s) named by the environment: ` +
      `${r.marked} ${dryRun ? "would be marked" : "marked"} internal, ` +
      `${r.alreadyMarked} already marked, ${r.withoutAccount} with no account here.`
  );
}

if (process.argv[1] && /seed-account-kind\.ts$/.test(process.argv[1])) {
  main()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error(err instanceof Error ? err.message : err);
      process.exit(1);
    });
}
