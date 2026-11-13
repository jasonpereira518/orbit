/**
 * What the `/radar` page and the dashboard's morning briefing render.
 *
 * The page is four statements: the pending list joined to its contacts; one read of the
 * account's Radar settings that also answers "is there anyone in the network" and "how many
 * signals came in this week"; whether AI can run for it; and what autopilot did lately. The
 * briefing is two: the run state, then the list.
 */
import { desc, eq, sql } from "drizzle-orm";
import { getDb, rowsOf } from "@/db";
import { contacts, radarRuns } from "@/db/schema";
import { clientAvatarUrlSql } from "@/lib/contact-avatar-sql";
import { loadInboxPeople, type InboxPerson } from "@/lib/email-intel/inbox-people";
import { BRIEFING_TOP, draftsReady, whatChanged, type BriefingLanes, type ChangeLine } from "@/lib/radar/briefing";
import { openRadarAi } from "@/lib/radar/explain";
import { loadRadarState, RADAR_LEASE_MS } from "@/lib/radar/run";
import { RADAR_CAPS } from "@/lib/radar/score";
import {
  listAutopilotActions,
  listPendingRecommendations,
  type AutopilotActionRow,
  type RecommendationRow,
} from "@/lib/radar/store";
import { LANE_OF_KIND, type RadarAutopilot } from "@/lib/radar/types";
import { listOpenOpportunities, type OpportunityView } from "@/lib/radar/opportunity-actions";

export type RadarSettingsView = {
  paused: boolean;
  autopilot: RadarAutopilot;
  digestEnabled: boolean;
  /** The same-day email when something on Today won't keep. */
  momentEmailEnabled: boolean;
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
  /** The weekly web pass's open finds: events, people to meet, programs. */
  opportunities: OpportunityView[];
  /** When this week's plan was built (the last weekly run). Null before the first. */
  weekBuiltAt: Date | null;
  /** What Radar still needs from the person. Only when the week is thin, else null. */
  coldStart: RadarColdStart | null;
};

/** The help panel's checklist: each item is done or not. */
export type RadarColdStart = { closePeople: number; hasCity: boolean; goals: number; recentNotes: boolean };
/** The week counts as thin below this many cards and finds together. */
export const RADAR_THIN_WEEK = 3;

type PageState = {
  last_run_at: string | Date | null;
  next_at: string | Date | null;
  paused: number | null;
  autopilot: RadarAutopilot | null;
  digest_enabled: number | null;
  moment_email: number | null;
  capture_linkedin: number | null;
  has_contacts: boolean;
  signals_week: number | string;
  email_intel: number | null;
  week_built_at: string | Date | null;
  close_people: number | string;
  has_city: boolean;
  goals: number | string;
  recent_notes: boolean;
};

async function loadPageState(userId: string): Promise<PageState | null> {
  const db = await getDb();
  const since = new Date(Date.now() - 7 * 86_400_000).toISOString();
  const notesSince = new Date(Date.now() - 30 * 86_400_000).toISOString();
  const [row] = rowsOf<PageState>(
    await db.execute(sql`
      SELECT s.radar_last_run_at AS last_run_at, s.radar_next_at AS next_at, s.radar_paused AS paused,
             s.radar_autopilot AS autopilot, s.radar_digest_enabled AS digest_enabled, s.radar_moment_email_enabled AS moment_email,
             s.radar_capture_linkedin_activity AS capture_linkedin, s.email_intel_enabled AS email_intel,
             EXISTS (SELECT 1 FROM contacts WHERE user_id = ${userId}) AS has_contacts,
             (SELECT count(*) FROM contact_signals WHERE user_id = ${userId} AND created_at > ${since}::timestamptz)
               + (SELECT count(*) FROM contact_career_moves WHERE user_id = ${userId} AND detected_at > ${since}::timestamptz)
               AS signals_week,
             (SELECT max(started_at) FROM radar_runs
               WHERE user_id = ${userId} AND status = 'ok' AND stats ->> 'mode' = 'weekly') AS week_built_at,
             -- The help panel's checklist, read here so a thin week costs no extra statement.
             (SELECT count(*) FROM contacts WHERE user_id = ${userId} AND stated_closeness >= 4) AS close_people,
             coalesce(nullif(s.career_profile ->> 'city', ''), nullif(s.career_profile -> 'profile' ->> 'location', '')) IS NOT NULL AS has_city,
             (SELECT count(*) FROM user_goals WHERE user_id = ${userId} AND active = 1) AS goals,
             EXISTS (SELECT 1 FROM interactions WHERE user_id = ${userId} AND interaction_date > ${notesSince}::timestamptz) AS recent_notes
        FROM (SELECT 1) one
        LEFT JOIN user_settings s ON s.user_id = ${userId}
    `)
  );
  return row ?? null;
}

const toDate = (v: string | Date | null | undefined) => (v ? new Date(v) : null);

export async function loadRadarPage(userId: string): Promise<RadarPageData> {
  const [recommendations, state, ai, autopilotActions, opportunities] = await Promise.all([
    listPendingRecommendations(userId, RADAR_CAPS.pending),
    loadPageState(userId),
    openRadarAi(userId),
    listAutopilotActions(userId),
    listOpenOpportunities(userId),
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
      momentEmailEnabled: (state?.moment_email ?? 1) !== 0,
      captureLinkedinActivity: state?.capture_linkedin === 1,
    },
    autopilotActions,
    changes: whatChanged(recommendations, now),
    signalsThisWeek: Number(state?.signals_week ?? 0),
    inboxPeople,
    opportunities,
    weekBuiltAt: toDate(state?.week_built_at),
    coldStart:
      state?.has_contacts && recommendations.length + opportunities.length < RADAR_THIN_WEEK
        ? {
            closePeople: Number(state.close_people ?? 0),
            hasCity: Boolean(state.has_city),
            goals: Number(state.goals ?? 0),
            recentNotes: Boolean(state.recent_notes),
          }
        : null,
  };
}

import type { NetworkStats } from "@/lib/network-stats";

export type RadarBriefing = {
  /** False until the account's first run: the dashboard keeps its legacy card until then. */
  hasRun: boolean;
  paused: boolean;
  /** The first few of Today, best first. */
  top: RecommendationRow[];
  /** Everyone on the list. */
  total: number;
  /** Today's moments (`bucket = 'today'`): the things that won't keep. */
  today: number;
  /** This week's plan by lane, finds included in Opportunities. */
  lanes: BriefingLanes;
  drafts: number;
  changes: ChangeLine[];
  /** Overview stats about the user's network. */
  networkStats?: NetworkStats | null;
  /** Count of active projects being tracked for context matching. */
  activeProjectsCount?: number;
};

/** The dashboard's morning briefing, in three statements. Never builds anything itself. */
export async function loadRadarBriefing(userId: string): Promise<RadarBriefing> {
  const state = await loadRadarState(userId);
  // `state.paused` means "not on" (never turned on, or switched off): the dashboard hides
  // Radar then, however much it ran before, and shows its legacy suggestions card instead.
  if (!state?.lastRunAt || state.paused) {
    return { hasRun: false, paused: state?.paused ?? false, top: [], total: 0, today: 0, lanes: { followUp: 0, connect: 0, opportunities: 0 }, drafts: 0, changes: [] };
  }
  const { listActiveProjectsForUser } = await import("@/lib/projects/store");
  const [pending, projects, finds] = await Promise.all([
    listPendingRecommendations(userId, RADAR_CAPS.pending),
    listActiveProjectsForUser(userId, { limit: 10 }).catch(() => []),
    listOpenOpportunities(userId).catch(() => []),
  ]);
  // Today's moments lead when there are any; otherwise the week's best few.
  const today = pending.filter((r) => r.bucket === "today");
  const lane = (l: string) => pending.filter((r) => LANE_OF_KIND[r.kind] === l).length;
  return {
    hasRun: true,
    paused: state.paused,
    top: (today.length > 0 ? today : pending).slice(0, BRIEFING_TOP),
    total: pending.length + finds.length,
    today: today.length,
    lanes: { followUp: lane("follow_up"), connect: lane("connect"), opportunities: lane("opportunities") + finds.length },
    drafts: draftsReady(pending),
    changes: whatChanged(pending, new Date()),
    activeProjectsCount: projects.length,
  };
}

/** One person in the turn-on scene. `photo` is a browser-safe URL, or null (drawn as a planet). */
export type ActivationFace = { contactId: string; name: string; photo: string | null };

export type RadarActivation = {
  on: boolean;
  /** Closest people first; empty when Radar is on (the scene is not drawn). */
  faces: ActivationFace[];
};

/** The turn-on scene's rings hold 6 + 9 + 12 people. */
export const ACTIVATION_FACES = 27;

/**
 * Is Radar on, and if not, who the turn-on scene draws. Two statements at most, and the
 * photo is decided in Postgres (`clientAvatarUrlSql`), so no photo bytes or paid lookups.
 */
export async function loadRadarActivation(userId: string): Promise<RadarActivation> {
  const state = await loadRadarState(userId);
  const on = state ? !state.paused : false;
  if (on) return { on, faces: [] };
  const db = await getDb();
  const rows = await db
    .select({ contactId: contacts.id, name: contacts.fullName, photo: clientAvatarUrlSql.as("photo") })
    .from(contacts)
    .where(eq(contacts.userId, userId))
    .orderBy(sql`${contacts.closeness} DESC NULLS LAST`, sql`${contacts.lastInteractionAt} DESC NULLS LAST`, desc(contacts.id))
    .limit(ACTIVATION_FACES);
  return { on, faces: rows.map((r) => ({ contactId: r.contactId, name: r.name, photo: r.photo ?? null })) };
}

export type RadarRunProgress = {
  /** A run is under way for this account right now. */
  running: boolean;
  /** What it is doing ("Writing drafts"), and how far (0-100, monotonic). */
  label: string | null;
  progress: number;
  /** "3 of 5" while a counted stage runs. */
  detail: string | null;
  /** The newest run's outcome; null before the account has any run. */
  status: "running" | "ok" | "partial" | "failed" | null;
};

/**
 * The newest run, for "Refresh now". `running` ignores a `running` row older than the lease: a
 * crashed run never finishes its row, and must not hold the bar on screen forever.
 */
export async function loadRunProgress(userId: string, now: Date = new Date()): Promise<RadarRunProgress> {
  const db = await getDb();
  const [run] = await db
    .select({
      status: radarRuns.status,
      startedAt: radarRuns.startedAt,
      stage: radarRuns.stage,
      progress: radarRuns.progress,
      detail: radarRuns.detail,
    })
    .from(radarRuns)
    .where(eq(radarRuns.userId, userId))
    .orderBy(desc(radarRuns.startedAt))
    .limit(1);
  if (!run) return { running: false, label: null, progress: 0, detail: null, status: null };
  const running = run.status === "running" && now.getTime() - run.startedAt.getTime() < RADAR_LEASE_MS;
  return { running, label: run.stage, progress: run.progress, detail: run.detail, status: run.status };
}
