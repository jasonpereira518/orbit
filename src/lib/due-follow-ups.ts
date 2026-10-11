import { and, eq, inArray, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { contacts } from "@/db/schema";
import { cadenceDueAtSql, effectiveCadenceSql, followUpDueSql } from "@/lib/contact-cadence-sql";
import {
  getClosenessCohortSlim,
  type ClosenessCohortSlimResult,
} from "@/lib/closeness-cohort";

/** How many due follow-ups the dashboard card, and every reader of its list, shows. */
export const DUE_FOLLOW_UP_CAP = 12;

type DueCandidate = {
  id: string;
  nextFollowUpAt: Date | null;
  /** When the keep-in-touch cadence lapses (`cadenceDueAtSql`); read only when nothing is booked. */
  cadenceDueAt?: Date | string | null;
  priorityLevel: number | null;
};

/** When the follow-up comes due: the booked date, else the lapsed cadence. Raw SQL extras may be strings. */
export const dueAtOf = (c: { nextFollowUpAt: Date | string | null; cadenceDueAt?: Date | string | null }) =>
  c.nextFollowUpAt ? new Date(c.nextFollowUpAt) : c.cadenceDueAt ? new Date(c.cadenceDueAt) : null;

/** The cadence label's inputs, set only when the row is due because of its cadence. */
export const keepInTouchOf = (c: {
  nextFollowUpAt: Date | string | null;
  effectiveCadence: number | string | null;
  cadenceIsOwn: boolean | null;
}) => ({
  keepInTouchDays: c.nextFollowUpAt || c.effectiveCadence == null ? null : Number(c.effectiveCadence),
  keepInTouchIsDefault: !c.nextFollowUpAt && c.effectiveCadence != null && !c.cadenceIsOwn,
});

/** The three computed extras both due lists read; never the raw columns. */
export const cadenceExtras = () => ({
  cadenceDueAt: cadenceDueAtSql().as("cadence_due_at"),
  effectiveCadence: effectiveCadenceSql().as("effective_cadence"),
  cadenceIsOwn: sql<boolean>`(${contacts.cadenceDays} > 0)`.as("cadence_is_own"),
});

const TIER_RANK = { inner: 0, mid: 1, outer: 2 } as const;

/**
 * The order the due follow-ups list is shown in: most overdue first, then closer
 * relationships, then higher priority, then id. One definition shared by the dashboard and
 * `loadDueFollowUps`, so the two can never disagree about who comes first.
 */
export function compareDueFollowUps(
  a: DueCandidate,
  b: DueCandidate,
  cohort: Pick<ClosenessCohortSlimResult, "byId">
): number {
  const aTime = dueAtOf(a)?.getTime() ?? 0;
  const bTime = dueAtOf(b)?.getTime() ?? 0;
  if (aTime !== bTime) return aTime - bTime;
  const aTier = cohort.byId.get(a.id)?.tier ?? "outer";
  const bTier = cohort.byId.get(b.id)?.tier ?? "outer";
  const tierDiff = TIER_RANK[aTier] - TIER_RANK[bTier];
  if (tierDiff !== 0) return tierDiff;
  const priorityDiff = (b.priorityLevel || 0) - (a.priorityLevel || 0);
  if (priorityDiff !== 0) return priorityDiff;
  // Without a final tiebreaker two contacts due the same day, in the same tier, at the
  // same priority order arbitrarily, and the list this is sliced to twelve from
  // reshuffles on every load.
  return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
}

export type DueFollowUp = {
  id: string;
  fullName: string;
  company: string | null;
  title: string | null;
  email: string | null;
  nextFollowUpAt: Date | null;
  /** When it came due: the booked follow-up, else the lapsed cadence. Never null on a due row. */
  dueAt: Date | null;
  lastInteractionAt: Date | null;
  /** The ring the cohort puts them in — the dashboard's `closenessById.get(id)?.tier`. */
  closenessTier: "inner" | "mid" | "outer" | null;
  /** Set only when due because of the cadence (nothing booked): its days, and whether it is the tier default. */
  keepInTouchDays: number | null;
  keepInTouchIsDefault: boolean;
};

/**
 * `getDashboardData(userId).dueFollowUps`, for readers that want only that list — the MCP
 * and chat tools, `/api/v1/followups` and the `followup.due` webhook. Same people, same
 * order, same cap, same values for these fields.
 *
 * The dashboard answers it from its whole-network scan (plus reminders, suggestions, goals,
 * the constellation, a hydration of ~150 contacts and the network metrics), which made
 * `due_followups` ~21 statements and a quarter-second of CPU at 3,000 contacts to return a
 * dozen rows. This reads only the contacts with a follow-up set, and hydrates the twelve.
 *
 * Due-ness is decided in JavaScript against a `now` taken after the reads, exactly as the
 * dashboard decides it; the SQL bound only has to be loose enough never to drop a row that
 * test would keep, so it allows an hour of clock skew between app and database.
 */
export async function loadDueFollowUps(
  userId: string,
  opts: { cohort?: Promise<ClosenessCohortSlimResult> } = {}
): Promise<DueFollowUp[]> {
  const db = await getDb();
  const [candidates, cohort] = await Promise.all([
    db.query.contacts.findMany({
      where: and(eq(contacts.userId, userId), followUpDueSql(sql`now() + interval '1 hour'`)),
      columns: { id: true, company: true, priorityLevel: true, nextFollowUpAt: true },
      extras: cadenceExtras(),
    }),
    opts.cohort ?? getClosenessCohortSlim(userId),
  ]);

  const now = new Date();
  const top = candidates
    .filter((c) => { const at = dueAtOf(c); return at !== null && at <= now; })
    .sort((a, b) => compareDueFollowUps(a, b, cohort))
    .slice(0, DUE_FOLLOW_UP_CAP);
  if (top.length === 0) return [];

  const detail = await db.query.contacts.findMany({
    where: and(
      eq(contacts.userId, userId),
      inArray(
        contacts.id,
        top.map((c) => c.id)
      )
    ),
    columns: { id: true, fullName: true, title: true, email: true, lastInteractionAt: true },
  });
  const detailById = new Map(detail.map((d) => [d.id, d]));

  return top.flatMap((c) => {
    const d = detailById.get(c.id);
    if (!d) return [];
    return [{
      id: c.id,
      fullName: d.fullName,
      company: c.company ?? null,
      title: d.title ?? null,
      email: d.email ?? null,
      nextFollowUpAt: c.nextFollowUpAt ?? null,
      dueAt: dueAtOf(c),
      lastInteractionAt: d.lastInteractionAt ?? null,
      closenessTier: cohort.byId.get(c.id)?.tier ?? null,
      ...keepInTouchOf(c),
    }];
  });
}
