/**
 * Everything the `/radar` page renders, in four statements: the pending list joined to its
 * contacts, the account's run state, whether AI can run for it, and whether there is anyone
 * in the network at all.
 */
import { sql } from "drizzle-orm";
import { getDb, rowsOf } from "@/db";
import { openRadarAi } from "@/lib/radar/explain";
import { loadRadarState } from "@/lib/radar/run";
import { RADAR_CAPS } from "@/lib/radar/score";
import { listPendingRecommendations, type RecommendationRow } from "@/lib/radar/store";

export type RadarPageData = {
  recommendations: RecommendationRow[];
  lastRunAt: Date | null;
  nextRunAt: Date | null;
  paused: boolean;
  aiAvailable: boolean;
  hasContacts: boolean;
};

async function hasAnyContact(userId: string): Promise<boolean> {
  const db = await getDb();
  const [row] = rowsOf<{ found: boolean }>(
    await db.execute(sql`SELECT EXISTS (SELECT 1 FROM contacts WHERE user_id = ${userId}) AS found`)
  );
  return Boolean(row?.found);
}

export async function loadRadarPage(userId: string): Promise<RadarPageData> {
  const [recommendations, state, ai, hasContacts] = await Promise.all([
    listPendingRecommendations(userId, RADAR_CAPS.pending),
    loadRadarState(userId),
    openRadarAi(userId),
    hasAnyContact(userId),
  ]);
  return {
    recommendations,
    lastRunAt: state?.lastRunAt ?? null,
    nextRunAt: state?.nextAt ?? null,
    paused: state?.paused ?? false,
    aiAvailable: ai !== null,
    hasContacts,
  };
}

/** Cards the dashboard previews, matching the legacy card's four. */
export const RADAR_PREVIEW_COUNT = 4;

export type RadarPreview = {
  /** False until the account's first run: the dashboard keeps its legacy card until then. */
  hasRun: boolean;
  items: RecommendationRow[];
  total: number;
};

/** The dashboard's Radar card, in two statements. Never builds anything itself. */
export async function loadRadarPreview(userId: string): Promise<RadarPreview> {
  const state = await loadRadarState(userId);
  if (!state?.lastRunAt) return { hasRun: false, items: [], total: 0 };
  const pending = await listPendingRecommendations(userId, RADAR_CAPS.pending);
  return { hasRun: true, items: pending.slice(0, RADAR_PREVIEW_COUNT), total: pending.length };
}
