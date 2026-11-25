/**
 * LinkedIn deep read: catching up people who imported before it existed. Driven by queries,
 * never flags; each thing owed is found by its own predicate and clears itself:
 *
 *   - your history   — a kept Positions.csv / Education.csv and no `career_profile.historyCheckedAt`
 *   - closeness      — a cohort whose snapshot was not drawn with the deep read
 *   - how you met    — digests owed an origin check (relationship-engine/origin-pass.ts)
 *
 * Before launch (`deepReadLaunched()` false) every path is scoped to admins, for whom the deep
 * read is already on. `runDeepReadCatchUp` is the hourly cron's one entry point.
 */
import { and, eq, sql, type SQL } from "drizzle-orm";
import { getDb, rowsOf } from "@/db";
import { imports } from "@/db/schema";
import { adminUserIds } from "@/lib/admin-ids";
import { loadYouCurrent, saveCareerPatch } from "@/lib/career-profile-server";
import { markCohortDirty } from "@/lib/closeness-materialize";
import { deepReadLaunched } from "@/lib/deep-read";
import { runImportJobById } from "@/lib/import-job-dispatch";
import { stageExportSignals } from "@/lib/linkedin-export-apply";
import { gunzipExportFile } from "@/lib/linkedin-export-store";
import { LINKEDIN_EXPORT_IMPORT_TYPE } from "@/lib/linkedin-export-type";
import {
  parseLinkedInEducationCsv,
  parseLinkedInEducationHistoryCsv,
  parseLinkedInPositionHistoryCsv,
  parseLinkedInPositionsCsv,
} from "@/lib/linkedin-you";
import { usersWithOriginWork } from "@/lib/relationship-engine/origin-pass";
import { kickRelationshipRun } from "@/lib/relationship-engine/runner";
import { reportError } from "@/lib/report-error";

const HISTORY_FILES = ["positions.csv", "education.csv"];
const SIGNAL_FILES = ["invitations.csv", "notes.csv", "recommendations_received.csv", "recommendations_given.csv"];
/** The history-and-notes loop stops starting users after this long; the rest wait an hour. */
const HISTORY_BUDGET_MS = 45_000;

/** `f` is import_files. A file at the archive's root or in a folder. */
function fileIs(names: string[]): SQL {
  return sql`(${sql.join(
    names.map((n) => sql`lower(f.path) = ${n} OR lower(f.path) LIKE ${`%/${n}`}`),
    sql` OR `
  )})`;
}

function inScope(column: SQL, onlyUsers: string[] | null): SQL {
  return onlyUsers ? sql`AND ${column} IN (${sql.join(onlyUsers.map((u) => sql`${u}`), sql`, `)})` : sql``;
}

/**
 * Only the named files of the user's kept export, newest first, by lowercased file name.
 * (`readExportTexts` would unzip Messages.csv for nothing.) An upload still arriving is not read.
 */
async function readKeptFiles(userId: string, names: string[]): Promise<{ importId: string; texts: Map<string, string> } | null> {
  const db = await getDb();
  const rows = rowsOf<{ import_id: string; path: string; gz: string }>(
    await db.execute(sql`
      SELECT f.import_id, f.path, f.gz
        FROM import_files f
        JOIN imports i ON i.id = f.import_id AND i.status <> 'staging'
       WHERE f.user_id = ${userId} AND ${fileIs(names)}
       ORDER BY f.created_at DESC
    `)
  );
  if (!rows.length) return null;
  const importId = rows[0].import_id;
  const texts = new Map<string, string>();
  for (const r of rows) {
    const name = r.path.toLowerCase().split("/").pop()!;
    if (r.import_id !== importId || texts.has(name)) continue;
    try {
      texts.set(name, gunzipExportFile(r.gz));
    } catch {
      // A corrupt file reads as absent.
    }
  }
  return { importId, texts };
}

/** Users with a kept Positions.csv or Education.csv, history still missing, and never checked. */
export async function usersNeedingHistory(limit: number, onlyUsers: string[] | null): Promise<string[]> {
  if (onlyUsers && !onlyUsers.length) return [];
  const db = await getDb();
  const profile = sql`coalesce(us.career_profile, '{}'::jsonb)`;
  const result = await db.execute(sql`
    SELECT DISTINCT f.user_id
      FROM import_files f
      JOIN imports i ON i.id = f.import_id AND i.status <> 'staging'
      LEFT JOIN user_settings us ON us.user_id = f.user_id
     WHERE ${fileIs(HISTORY_FILES)}
       AND NOT jsonb_exists(${profile}, 'historyCheckedAt')
       AND NOT (jsonb_exists(${profile}, 'positions') AND jsonb_exists(${profile}, 'education'))
       ${inScope(sql`f.user_id`, onlyUsers)}
     LIMIT ${limit}
  `);
  return rowsOf<{ user_id: string }>(result).map((r) => r.user_id);
}

const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/**
 * Writes `positions[]` / `education[]` from the kept export, with no new review, only when the
 * person already applied that file's own details: the role on their profile is the one the file
 * gives, or every school in the file is on their schools list. (`role` alone is not proof:
 * onboarding can set it from a web lookup.) Both also need `career.importedAt`: every apply sets
 * it and "Remove imported details" drops it, while the schools list (not part of career_profile)
 * survives a Remove. Always stamps `historyCheckedAt`, so each person is
 * looked at once, and "Remove imported details" (which keeps the stamp) is never undone.
 */
export async function catchUpHistory(userId: string, now: Date = new Date()): Promise<{ positions: number; education: number }> {
  const out = { positions: 0, education: 0 };
  const you = await loadYouCurrent(userId);
  if (you.career?.historyCheckedAt) return out;
  const kept = await readKeptFiles(userId, HISTORY_FILES);
  const career: { positions?: ReturnType<typeof parseLinkedInPositionHistoryCsv>; education?: ReturnType<typeof parseLinkedInEducationHistoryCsv> } = {};

  const positionsText = kept?.texts.get("positions.csv");
  const role = you.career?.role;
  if (positionsText && role && you.career?.importedAt && !you.career?.positions?.length) {
    try {
      const current = parseLinkedInPositionsCsv(positionsText);
      if (current && same(current.title, role.title) && same(current.company, role.company)) {
        const positions = parseLinkedInPositionHistoryCsv(positionsText);
        if (positions.length) career.positions = positions;
      }
    } catch {
      // Not LinkedIn's Positions.csv after all: nothing to write.
    }
  }
  const educationText = kept?.texts.get("education.csv");
  if (educationText && you.career?.importedAt && !you.career?.education?.length) {
    try {
      const schools = parseLinkedInEducationCsv(educationText);
      if (schools.every((s) => you.schools.some((mine) => same(mine, s)))) {
        const education = parseLinkedInEducationHistoryCsv(educationText);
        if (education.length) career.education = education;
      }
    } catch {
      // Not LinkedIn's Education.csv, or it lists no schools.
    }
  }

  await saveCareerPatch(userId, { career: { ...career, historyCheckedAt: now.toISOString() }, senderBio: null, schools: null, message: "" });
  out.positions = career.positions?.length ?? 0;
  out.education = career.education?.length ?? 0;
  // Where your history and a contact's overlap counts toward closeness.
  if (out.positions || out.education) await markCohortDirty(userId);
  return out;
}

/**
 * Exports uploaded before the per-person notes were read (Oct 15 to Nov 12) kept their files
 * but staged nothing. Stage the notes now, once: only for a user with no `li-export:` row at all,
 * whose kept export is completed and has no staged rows. Target companies, wanted job titles and
 * background are NOT re-applied: that would bring back targets the person removed and overwrite
 * their background. Returns rows staged.
 *
 * A second run of the completed import attaches the new rows and runs the engine's usual
 * end-of-job upkeep; the import's history row reads "In progress" until it ends. No new import
 * row, no notification, no second Undo entry (the export creates no contacts).
 */
export async function restageExportSignals(userId: string, opts: { run?: (importId: string) => Promise<void> } = {}): Promise<number> {
  const db = await getDb();
  const [has] = rowsOf(await db.execute(sql`SELECT 1 FROM interactions WHERE user_id = ${userId} AND external_id LIKE 'li-export:%' LIMIT 1`));
  if (has) return 0;
  const kept = await readKeptFiles(userId, SIGNAL_FILES);
  if (!kept) return 0;
  const mine = and(eq(imports.id, kept.importId), eq(imports.userId, userId));
  const row = await db.query.imports.findFirst({ where: mine, columns: { importType: true, status: true } });
  if (row?.importType !== LINKEDIN_EXPORT_IMPORT_TYPE || row.status !== "completed") return 0;
  const [{ n }] = rowsOf<{ n: number }>(await db.execute(sql`SELECT count(*)::int AS n FROM import_job_rows WHERE import_id = ${kept.importId}::uuid`));
  if (Number(n) > 0) return 0;

  const staged = await stageExportSignals(userId, kept.importId, kept.texts);
  if (!staged) return 0;
  await db.update(imports).set({ status: "processing", totalRows: staged, updatedAt: new Date() }).where(mine);
  // ponytail: run inline, bounded by the engine's own time budget (it self-continues, and the
  // stalled-import backstop resumes it). Kick the import route instead if exports get large.
  await (opts.run ?? runImportJobById)(kept.importId);
  return staged;
}

/**
 * Closeness counts LinkedIn evidence only when a cohort is drawn with the deep read on. Mark
 * the ones that were not; the cron's recalibrate stage does the work, and a cohort redrawn with
 * it on (`snapshot.deepRead`) stops matching. Returns rows marked.
 */
export async function markCohortsForDeepRead(onlyUsers: string[] | null): Promise<number> {
  if (onlyUsers && !onlyUsers.length) return 0;
  const db = await getDb();
  const result = await db.execute(sql`
    UPDATE closeness_cohorts
       SET dirty_at = coalesce(dirty_at, now())
     WHERE coalesce(snapshot->>'deepRead', '') <> 'true'
       ${inScope(sql`user_id`, onlyUsers)}
    RETURNING user_id
  `);
  return rowsOf(result).length;
}

export type CatchUpStats = { deepHistoryCaughtUp: number; deepSignalsRestaged: number; deepCohortsMarked: number; deepOriginKicks: number };

export async function runDeepReadCatchUp(
  opts: { limit?: number; kick?: (userId: string) => Promise<void>; run?: (importId: string) => Promise<void> } = {}
): Promise<CatchUpStats> {
  const stats: CatchUpStats = { deepHistoryCaughtUp: 0, deepSignalsRestaged: 0, deepCohortsMarked: 0, deepOriginKicks: 0 };
  const scope = (await deepReadLaunched()) ? null : adminUserIds();
  if (scope && !scope.length) return stats;
  const limit = opts.limit ?? 25;
  const kick = opts.kick ?? kickRelationshipRun;

  const deadline = Date.now() + HISTORY_BUDGET_MS;
  for (const userId of await usersNeedingHistory(limit, scope)) {
    if (Date.now() > deadline) break;
    try {
      // Notes first: the stamp below is what stops this user being listed again.
      stats.deepSignalsRestaged += await restageExportSignals(userId, { run: opts.run });
      await catchUpHistory(userId);
      stats.deepHistoryCaughtUp += 1;
    } catch (err) {
      reportError(err, { where: "job.deep-read-catch-up.history", userId, level: "warning" });
    }
  }

  stats.deepCohortsMarked = await markCohortsForDeepRead(scope);

  for (const userId of await usersWithOriginWork(limit, scope)) {
    // A no-op once stamped; first, so the overlap is in the origin prompt.
    await catchUpHistory(userId).catch((err) => reportError(err, { where: "job.deep-read-catch-up.history", userId, level: "warning" }));
    await kick(userId);
    stats.deepOriginKicks += 1;
  }
  return stats;
}
