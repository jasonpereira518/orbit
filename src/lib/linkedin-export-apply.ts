/**
 * Read a kept LinkedIn export's useful files and act on them. Server-side, from the stored
 * files, so nothing is uploaded twice. No auth: callers pass the user id (PGlite smokes drive it).
 *
 *   - Per-person notes → staged as `import_job_rows` for the engine (`linkedinSignalsAdapter`).
 *   - Target companies → added to `target_companies`, never changing a row the user already has.
 *   - Wanted job titles → merged into `career_profile.roleKeywords`; background → replaces
 *     `career_profile.background` (the latest export says what is current).
 */
import { eq, sql } from "drizzle-orm";
import { getDb, rowsOf } from "@/db";
import { targetCompanies } from "@/db/schema";
import { loadYouCurrent, saveCareerPatch } from "@/lib/career-profile-server";
import { resolveCompany } from "@/lib/companies";
import { stageImportRows } from "@/lib/import-job-rows";
import {
  parseExportBackground,
  parseExportJobTitles,
  parseExportSignals,
  parseExportTargets,
} from "@/lib/linkedin-export-extras";
import { readExportTexts } from "@/lib/linkedin-export-store";

const MAX_ROLE_KEYWORDS = 10;

export type ExportExtrasOutcome = { rows: number; targetsAdded: number; backgroundAdded: number };

export async function applyExportExtras(userId: string, importId: string): Promise<ExportExtrasOutcome> {
  const texts = await readExportTexts(userId, importId);

  const signals = parseExportSignals(texts);
  await stageImportRows(signals.map((payload, rowIndex) => ({ importId, userId, rowIndex, payload })));

  // ponytail: one resolveCompany round trip per target (≤ 50). Batch it if exports grow.
  let targetsAdded = 0;
  const db = await getDb();
  const have = new Set(
    (await db.select({ id: targetCompanies.companyId }).from(targetCompanies).where(eq(targetCompanies.userId, userId))).map(
      (r) => r.id,
    ),
  );
  for (const t of parseExportTargets(texts)) {
    const company = await resolveCompany(userId, t.name);
    if (!company || have.has(company.id)) continue;
    const inserted = rowsOf<{ id: string }>(
      await db.execute(sql`
        INSERT INTO target_companies (user_id, company_id, priority, note)
        VALUES (${userId}, ${company.id}::uuid, ${t.priority}, ${t.note})
        ON CONFLICT (user_id, company_id) DO NOTHING
        RETURNING id
      `),
    );
    have.add(company.id);
    targetsAdded += inserted.length;
  }

  const background = parseExportBackground(texts);
  const titles = parseExportJobTitles(texts);
  if (background.length || titles.length) {
    const { career } = await loadYouCurrent(userId);
    const keywords = [...(career?.roleKeywords ?? [])];
    for (const t of titles) {
      if (!keywords.some((k) => k.toLowerCase() === t.toLowerCase())) keywords.push(t);
    }
    await saveCareerPatch(userId, {
      career: {
        ...(background.length ? { background } : {}),
        ...(titles.length ? { roleKeywords: keywords.slice(0, MAX_ROLE_KEYWORDS) } : {}),
        importedAt: new Date().toISOString(),
      },
      senderBio: null,
      message: "",
    });
  }

  return { rows: signals.length, targetsAdded, backgroundAdded: background.length };
}
