/**
 * What the `/radar` page and the dashboard's morning briefing render.
 *
 * The page is four statements: the pending list joined to its contacts; one read of the
 * account's Radar settings that also answers "is there anyone in the network" and "how many
 * signals came in this week"; whether AI can run for it; and what autopilot did lately. The
 * briefing is two: the run state, then the list.
 */
import { sql } from "drizzle-orm";
import { getDb, rowsOf } from "@/db";
import { loadInboxPeople, type InboxPerson } from "@/lib/email-intel/inbox-people";
import { BRIEFING_TOP, draftsReady, whatChanged, type ChangeLine } from "@/lib/radar/briefing";
import { openRadarAi } from "@/lib/radar/explain";
import { loadRadarState } from "@/lib/radar/run";
import { RADAR_CAPS } from "@/lib/radar/score";
import {
  listAutopilotActions,
  listPendingRecommendations,
  type AutopilotActionRow,
  type RecommendationRow,
} from "@/lib/radar/store";
import type { RadarAutopilot } from "@/lib/radar/types";

export type RadarSettingsView = {
  paused: boolean;
  autopilot: RadarAutopilot;
  digestEnabled: boolean;
  captureLinkedinActivity: boolean;
};

export type RadarPageData = {
  recommendations: RecommendationRow[];
  lastRunAt: Date | null;
  /** When the next nightly check is due; null when it already is (it runs tonight). */
  nextRunAt: Date | null;
  paused: boolean;
  aiAvailable: boolean;
  hasContacts: boolean;
  settings: RadarSettingsView;
  autopilotActions: AutopilotActionRow[];
  changes: ChangeLine[];
  /** Job moves, headlines and posts Radar noticed in the last seven days. */
  signalsThisWeek: number;
  /** People the account's email names who are not in the network yet. Empty unless Email insights is on. */
  inboxPeople: InboxPerson[];
};

type PageState = {
  last_run_at: string | Date | null;
  next_at: string | Date | null;
  paused: number | null;
  autopilot: RadarAutopilot | null;
  digest_enabled: number | null;
  capture_linkedin: number | null;
  has_contacts: boolean;
  signals_week: number | string;
  email_intel: number | null;
};

async function loadPageState(userId: string): Promise<PageState | null> {
  const db = await getDb();
  const since = new Date(Date.now() - 7 * 86_400_000).toISOString();
  const [row] = rowsOf<PageState>(
    await db.execute(sql`
      SELECT s.radar_last_run_at AS last_run_at, s.radar_next_at AS next_at, s.radar_paused AS paused,
             s.radar_autopilot AS autopilot, s.radar_digest_enabled AS digest_enabled,
             s.radar_capture_linkedin_activity AS capture_linkedin, s.email_intel_enabled AS email_intel,
             EXISTS (SELECT 1 FROM contacts WHERE user_id = ${userId}) AS has_contacts,
             (SELECT count(*) FROM contact_signals WHERE user_id = ${userId} AND created_at > ${since}::timestamptz)
               + (SELECT count(*) FROM contact_career_moves WHERE user_id = ${userId} AND detected_at > ${since}::timestamptz)
               AS signals_week
        FROM (SELECT 1) one
        LEFT JOIN user_settings s ON s.user_id = ${userId}
    `)
  );
  return row ?? null;
}

const toDate = (v: string | Date | null | undefined) => (v ? new Date(v) : null);

export async function loadRadarPage(userId: string): Promise<RadarPageData> {
  const [recommendations, state, ai, autopilotActions] = await Promise.all([
    listPendingRecommendations(userId, RADAR_CAPS.pending),
    loadPageState(userId),
    openRadarAi(userId),
    listAutopilotActions(userId),
  ]);
  const paused = state?.paused === 1;
  const now = new Date();
  const nextAt = toDate(state?.next_at);
  // Read only for an account that opted in, so everyone else pays nothing for it. A failure
  // here must never cost the page its cards.
  const inboxPeople = state?.email_intel === 1 ? await loadInboxPeople(userId, now).catch(() => []) : [];
  return {
    recommendations,
    lastRunAt: toDate(state?.last_run_at),
    nextRunAt: nextAt && nextAt > now ? nextAt : null,
    paused,
    aiAvailable: ai !== null,
    hasContacts: Boolean(state?.has_contacts),
    settings: {
      paused,
      autopilot: state?.autopilot ?? {},
      digestEnabled: (state?.digest_enabled ?? 1) !== 0,
      captureLinkedinActivity: state?.capture_linkedin === 1,
    },
    autopilotActions,
    changes: whatChanged(recommendations, now),
    signalsThisWeek: Number(state?.signals_week ?? 0),
    inboxPeople,
  };
}

export type RadarBriefing = {
  /** False until the account's first run: the dashboard keeps its legacy card until then. */
  hasRun: boolean;
  paused: boolean;
  /** The first few of Today, best first. */
  top: RecommendationRow[];
  /** Everyone on the list. */
  total: number;
  /** Today's section, as `/radar` draws it. */
  today: number;
  drafts: number;
  changes: ChangeLine[];
};

/** The dashboard's morning briefing, in two statements. Never builds anything itself. */
export async function loadRadarBriefing(userId: string): Promise<RadarBriefing> {
  const state = await loadRadarState(userId);
  if (!state?.lastRunAt) {
    return { hasRun: false, paused: state?.paused ?? false, top: [], total: 0, today: 0, drafts: 0, changes: [] };
  }
  const pending = await listPendingRecommendations(userId, RADAR_CAPS.pending);
  const today = pending.slice(0, RADAR_CAPS.today);
  return {
    hasRun: true,
    paused: state.paused,
    top: today.slice(0, BRIEFING_TOP),
    total: pending.length,
    today: today.length,
    drafts: draftsReady(pending),
    changes: whatChanged(pending, new Date()),
  };
}
