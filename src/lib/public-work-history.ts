import { and, eq, gt, isNull, lt, or, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { publicWorkHistory } from "@/db/schema";
import { sanitizeIncomingExperiences, type IncomingExperience } from "@/lib/contact-profile";

/**
 * Work history found by a public web search, shared across accounts by LinkedIn profile slug —
 * the photo cache's pattern (`linkedin_avatars`, #438) for the costliest lookup Orbit runs. Two
 * accounts with the same connection used to pay for the same searches twice.
 *
 * Only a CONFIDENT answer from a public web search is written (`researchOnce`): never an
 * extension capture, anything a user typed or imported, or an unsure guess. A blocked row
 * (the admin takedown in `admin-avatars.ts`) carries no answer and is never rewritten.
 */

/** A shared answer is reused this long by automatic checks. */
export const PUBLIC_WORK_HISTORY_DAYS = 30;
/** Rows are deleted after this, and as soon as no account has a contact with the slug. */
const PUBLIC_WORK_HISTORY_MAX_DAYS = 90;
const SWEEP_BATCH = 500;
const DAY_MS = 86_400_000;

export type PublicWorkHistory = {
  headline: string | null;
  experiences: IncomingExperience[];
  sources: Array<{ url: string; title: string | null }>;
};

/** The shared answer for a slug, if one is younger than `maxAgeDays` and not blocked. Never throws. */
export async function readPublicWorkHistory(
  slug: string | null | undefined,
  maxAgeDays: number,
  now: Date = new Date(),
): Promise<PublicWorkHistory | null> {
  if (!slug) return null;
  try {
    const db = await getDb();
    const [row] = await db
      .select({ answer: publicWorkHistory.answer })
      .from(publicWorkHistory)
      .where(
        and(
          eq(publicWorkHistory.slug, slug),
          isNull(publicWorkHistory.blockedAt),
          gt(publicWorkHistory.resolvedAt, new Date(now.getTime() - maxAgeDays * DAY_MS)),
        ),
      )
      .limit(1);
    if (!row?.answer) return null;
    // Stored by another account's search: re-sanitized on the way out, like any web answer.
    const experiences = sanitizeIncomingExperiences(row.answer.experiences);
    return experiences.length
      ? { headline: row.answer.headline ?? null, experiences, sources: row.answer.sources ?? [] }
      : null;
  } catch {
    // An unreadable cache is a miss: the account searches for itself, as before.
    return null;
  }
}

/** Shares a confident answer under its slug, unless the slug is blocked. Never throws. */
export async function writePublicWorkHistory(
  slug: string | null | undefined,
  answer: PublicWorkHistory,
  now: Date = new Date(),
): Promise<void> {
  if (!slug || !answer.experiences.length) return;
  try {
    const db = await getDb();
    const value = { headline: answer.headline, experiences: answer.experiences, sources: answer.sources.slice(0, 8) };
    await db
      .insert(publicWorkHistory)
      .values({ slug, answer: value, resolvedAt: now })
      .onConflictDoUpdate({
        target: publicWorkHistory.slug,
        set: { answer: value, resolvedAt: now },
        setWhere: isNull(publicWorkHistory.blockedAt),
      });
  } catch {
    // Not sharing costs the next account one search; failing here would cost this one its answer.
  }
}

/**
 * Deletes shared answers older than PUBLIC_WORK_HISTORY_MAX_DAYS and those no account has a
 * contact for any more — work history about a stranger is kept only while someone knows them.
 * Blocked rows stay: they are the takedown. Returns rows removed.
 */
export async function sweepPublicWorkHistory(now: Date = new Date()): Promise<number> {
  const db = await getDb();
  const stale = new Date(now.getTime() - PUBLIC_WORK_HISTORY_MAX_DAYS * DAY_MS);
  const gone = await db
    .delete(publicWorkHistory)
    .where(
      and(
        isNull(publicWorkHistory.blockedAt),
        or(
          lt(publicWorkHistory.resolvedAt, stale),
          sql`NOT EXISTS (SELECT 1 FROM contacts c WHERE c.linkedin_slug = ${publicWorkHistory.slug})`,
        ),
        sql`${publicWorkHistory.slug} IN (SELECT slug FROM public_work_history WHERE blocked_at IS NULL LIMIT ${SWEEP_BATCH})`,
      ),
    )
    .returning();
  return gone.length;
}
