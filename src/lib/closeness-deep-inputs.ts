/**
 * The LinkedIn deep read's closeness inputs, read from the database the same way for the whole
 * cohort (`buildCohortResult`) and for one contact (`rescoreContact`), so one contact can never
 * score two ways. Its own file because closeness-cohort.ts already imports from
 * closeness-materialize.ts: either of them holding this would be an import cycle.
 */
import { and, eq, inArray, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { contactExperiences, interactions } from "@/db/schema";
import { loadYouCurrent } from "@/lib/career-profile-server";
import { depthComponent, overlapAffinity, type DepthSignals } from "@/lib/closeness-depth";
import { historyOverlaps, type OverlapExperience } from "@/lib/history-overlap";
import { EXCHANGE_TOUCH_TYPES, sqlList } from "@/lib/touch-kinds";

const EXCHANGE_TYPES = sql.raw(sqlList(EXCHANGE_TOUCH_TYPES));

/**
 * Added to the per-contact `interactions` scan both paths already run (rows that count as a
 * touch). All time, unlike cadence: years of two-way exchange are what a LinkedIn export proves.
 */
export const depthAggregates = {
  depthInbound: sql<number>`count(*) filter (where ${interactions.interactionType} in ${EXCHANGE_TYPES} and ${interactions.direction} = 'in')::int`,
  depthOutbound: sql<number>`count(*) filter (where ${interactions.interactionType} in ${EXCHANGE_TYPES} and ${interactions.direction} = 'out')::int`,
  exchangeYears: sql<number>`count(distinct extract(year from ${interactions.interactionDate})) filter (where ${interactions.interactionType} in ${EXCHANGE_TYPES})::int`,
  recommendations: sql<number>`count(*) filter (where ${interactions.externalId} like 'li-export:recommendation%')::int`,
};

export type DepthAggregateRow = { [K in keyof typeof depthAggregates]?: number | string | null };

export function depthSignalsOf(row: DepthAggregateRow | undefined): DepthSignals {
  return {
    inbound: Number(row?.depthInbound ?? 0) || 0,
    outbound: Number(row?.depthOutbound ?? 0) || 0,
    exchangeYears: Number(row?.exchangeYears ?? 0) || 0,
    recommendations: Number(row?.recommendations ?? 0) || 0,
  };
}

export type DeepClosenessFields = { depth: number; historyOverlap: { work: number; school: number } | null };

/** Above this many contacts, read every experience row of the user rather than an IN list. */
const IN_LIST_MAX = 500;

/**
 * `depth` for every person, and `historyOverlap` when the user's own history is known (PR 1:
 * `career_profile.positions` / `education`, or schools typed in Settings). A contact's side is
 * its `contact_experiences`, or, with none, its company and school with no years, as the
 * relationship engine's prompt reads it (relationship-engine/runner.ts).
 */
export async function deepClosenessInputs(
  userId: string,
  people: ReadonlyArray<{ id: string; company?: string | null; school?: string | null }>,
  signals: ReadonlyMap<string, DepthSignals>,
  now: Date = new Date()
): Promise<Map<string, DeepClosenessFields>> {
  const you = await loadYouCurrent(userId);
  const mine = { positions: you.career?.positions, education: you.career?.education, schools: you.schools };
  const hasHistory = Boolean(mine.positions?.length || mine.education?.length || mine.schools.length);

  const theirs = new Map<string, OverlapExperience[]>();
  if (hasHistory && people.length) {
    const db = await getDb();
    const ids = people.map((p) => p.id);
    const rows = await db
      .select({
        contactId: contactExperiences.contactId,
        kind: contactExperiences.kind,
        organization: contactExperiences.organization,
        startYear: contactExperiences.startYear,
        endYear: contactExperiences.endYear,
        isCurrent: contactExperiences.isCurrent,
      })
      .from(contactExperiences)
      .where(
        ids.length <= IN_LIST_MAX
          ? and(eq(contactExperiences.userId, userId), inArray(contactExperiences.contactId, ids))
          : eq(contactExperiences.userId, userId)
      );
    for (const { contactId, ...e } of rows) {
      const list = theirs.get(contactId) ?? [];
      list.push(e);
      theirs.set(contactId, list);
    }
  }

  const plain = (kind: OverlapExperience["kind"], organization: string | null | undefined): OverlapExperience[] =>
    organization ? [{ kind, organization, startYear: null, endYear: null, isCurrent: false }] : [];
  const out = new Map<string, DeepClosenessFields>();
  for (const p of people) {
    const them = theirs.get(p.id) ?? [...plain("role", p.company), ...plain("education", p.school)];
    out.set(p.id, {
      depth: depthComponent(signals.get(p.id) ?? depthSignalsOf(undefined)),
      historyOverlap: hasHistory ? overlapAffinity(historyOverlaps(mine, them, now.getUTCFullYear())) : null,
    });
  }
  return out;
}
