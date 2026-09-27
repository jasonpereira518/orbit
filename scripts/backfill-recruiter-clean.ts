/**
 * Clean recruiter rows written before shared fields were sanitized on write.
 *
 * `recruiters` rows are shared across accounts once anyone contributes to them, and their
 * `full_name`, `firm` and `specialty` are read into other users' chat prompts. Since the AI
 * security audit (docs/ai-security-audit-2026-09-26.md, finding 2) every write goes through
 * `cleanRecruiterFields`; this brings the rows that predate it into line with the same rule,
 * via `recruiterCleanPatch`, so there is one definition of "clean".
 *
 * Idempotent: a row that already complies produces no patch. Never blanks a name. Prints
 * each change as ids and before/after lengths, never the text itself — the text is the
 * suspect payload.
 *
 * TARGETS `DATABASE_URL`, and refuses to run without one (see `requireRealDatabase`).
 *
 * Run: npx tsx scripts/backfill-recruiter-clean.ts [--dry]
 */
import { requireRealDatabase } from "./lib/operational-db";
import { asc, eq, gt } from "drizzle-orm";
import { getDb } from "../src/db";
import { recruiters } from "../src/db/schema";
import { recruiterCleanPatch } from "../src/lib/recruiters";

const BATCH = 500;

async function main() {
  const dry = process.argv.includes("--dry");
  requireRealDatabase("backfill-recruiter-clean");
  const db = await getDb();

  let after = "";
  let scanned = 0;
  let changed = 0;
  for (;;) {
    const rows = await db
      .select({ id: recruiters.id, fullName: recruiters.fullName, firm: recruiters.firm, specialty: recruiters.specialty })
      .from(recruiters)
      .where(after ? gt(recruiters.id, after) : undefined)
      .orderBy(asc(recruiters.id))
      .limit(BATCH);
    if (!rows.length) break;
    for (const row of rows) {
      scanned++;
      const patch = recruiterCleanPatch(row);
      if (!patch) continue;
      changed++;
      console.log(
        `${dry ? "would clean" : "cleaned"} ${row.id}: ${Object.keys(patch).join(", ")} ` +
          `(name ${row.fullName.length}→${(patch.fullName ?? row.fullName).length} chars)`
      );
      if (!dry) await db.update(recruiters).set({ ...patch, updatedAt: new Date() }).where(eq(recruiters.id, row.id));
    }
    after = rows[rows.length - 1].id;
  }
  console.log(`\n${scanned} recruiter row(s) scanned, ${changed} ${dry ? "would change" : "changed"}.`);
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
