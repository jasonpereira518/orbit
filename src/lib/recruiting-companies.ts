import { and, desc, eq, isNotNull, isNull } from "drizzle-orm";
import { getDb } from "@/db";
import { emailEvents, emailThreads, recruitingOverrides, userSettings } from "@/db/schema";
import { isRecruiterStage, type RecruiterStage } from "@/lib/recruiter-stages";
import { foldCompanies, type BoardCompany } from "@/lib/recruiting-board";

/**
 * The Recruiting board's reads and writes. The board is a fold over the stage changes email
 * insights recorded (`foldCompanies`); the only thing stored here is what the person corrected.
 */

/** More than a mailbox's recruiting year holds, and a ceiling on the read all the same. */
const MAX_EVENTS = 3000;

export type RecruitingBoard = {
  companies: BoardCompany[];
  /** "Not a job", kept so "Put it back" has something to point at. */
  hidden: BoardCompany[];
};

export async function loadRecruitingBoard(userId: string): Promise<RecruitingBoard> {
  const db = await getDb();
  const [events, overrides] = await Promise.all([
    db
      .select({
        company: emailEvents.company,
        role: emailEvents.role,
        stage: emailEvents.stage,
        occurredAt: emailEvents.occurredAt,
        source: emailEvents.source,
        summary: emailEvents.summary,
        threadId: emailThreads.threadId,
      })
      .from(emailEvents)
      .innerJoin(emailThreads, eq(emailEvents.threadRowId, emailThreads.id))
      .where(
        and(
          eq(emailEvents.userId, userId),
          eq(emailEvents.kind, "process_update"),
          // Dismissed elsewhere (Radar's cards): not a live process any more.
          isNull(emailEvents.dismissedAt),
          isNotNull(emailEvents.company),
          isNotNull(emailEvents.stage)
        )
      )
      .orderBy(desc(emailEvents.occurredAt))
      .limit(MAX_EVENTS),
    db.select().from(recruitingOverrides).where(eq(recruitingOverrides.userId, userId)),
  ]);
  return foldCompanies(
    events,
    overrides.map((o) => ({ companyKey: o.companyKey, hiddenAt: o.hiddenAt, stage: o.stage, stageAt: o.stageAt }))
  );
}

export type InsightsStatus = {
  /** The Email insights switch. The board is empty without it. */
  enabled: boolean;
  /** When the sweep last finished a whole pass over the mailbox; null before the first. */
  lastSweepAt: Date | null;
};

export async function getInsightsStatus(userId: string): Promise<InsightsStatus> {
  const db = await getDb();
  const row = await db.query.userSettings.findFirst({
    where: eq(userSettings.userId, userId),
    columns: { emailIntelEnabled: true, emailIntelCursorAt: true },
  });
  return { enabled: (row?.emailIntelEnabled ?? 0) === 1, lastSweepAt: row?.emailIntelCursorAt ?? null };
}

/**
 * A stage set by hand. It starts the fold at this moment: older mail cannot move it, newer
 * mail can (see `foldCompanies`).
 */
export async function setCompanyStageForUser(userId: string, key: string, stage: RecruiterStage): Promise<void> {
  if (!key || !isRecruiterStage(stage)) return;
  const db = await getDb();
  const now = new Date();
  await db
    .insert(recruitingOverrides)
    .values({ userId, companyKey: key, stage, stageAt: now, updatedAt: now })
    .onConflictDoUpdate({
      target: [recruitingOverrides.userId, recruitingOverrides.companyKey],
      set: { stage, stageAt: now, updatedAt: now },
    });
}

/** "Not a job" (hidden) or "Put it back". New mail never clears it. */
export async function setCompanyHiddenForUser(userId: string, key: string, hidden: boolean): Promise<void> {
  if (!key) return;
  const db = await getDb();
  const now = new Date();
  await db
    .insert(recruitingOverrides)
    .values({ userId, companyKey: key, hiddenAt: hidden ? now : null, updatedAt: now })
    .onConflictDoUpdate({
      target: [recruitingOverrides.userId, recruitingOverrides.companyKey],
      set: { hiddenAt: hidden ? now : null, updatedAt: now },
    });
}
