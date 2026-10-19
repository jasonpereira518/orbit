"use server";

/**
 * The `/radar` page's server actions. Each derives the user from the session and checks
 * the surface first (`requireUserForReleasedSurface`), then calls the request-free functions in
 * `src/lib/radar/actions-core.ts`, so the smoke drives the same code.
 */
import { cookies } from "next/headers";
import { after } from "next/server";
import { AI_ACCESS_COPY } from "@/lib/ai-access-copy";
import { friendlyError } from "@/lib/errors";
import { requireUserForReleasedSurface } from "@/lib/plan-guards";
import { RATE_LIMITS, consumeBucket, isRateLimitedError } from "@/lib/rate-limit";
import { revalidatePathIfRequestScoped, revalidateReminderPaths } from "@/lib/reminder-paths";
import {
  dismissRecommendationForUser,
  neverForContactForUser,
  restoreRecommendationForUser,
  scheduleRecommendationForUser,
  snoozeRecommendationForUser,
  SCHEDULE_DAYS,
  SNOOZE_DAYS,
  type ScheduleDays,
  type SnoozeLength,
} from "@/lib/radar/actions-core";
import { explainRecommendation } from "@/lib/radar/explain";
import { loadRadarBriefing, loadRadarPage, type RadarBriefing, type RadarPageData } from "@/lib/radar/page-data";
import { claimRadarLease, ensureRadarRun, maybeRefreshRadar, runRadarForUser } from "@/lib/radar/run";
import { markRecommendationsSeen } from "@/lib/radar/store";
import { getDb } from "@/db";
import { userSettings } from "@/db/schema";
import { eq, sql } from "drizzle-orm";
import { undoAutopilotForUser } from "@/lib/radar/autopilot";
import { captureRadarTimeZone } from "@/lib/radar/digest";
import { TZ_COOKIE } from "@/lib/reminder-due-bucket";
import { KIND_LABELS, RECOMMENDATION_KINDS, type RecommendationKind } from "@/lib/radar/types";
import type { NetworkStats } from "@/lib/network-stats";
import { z } from "zod";
import { defineAction, failMessage } from "@/lib/input/action";

const SURFACE = "page.radar";

function revalidateRadar() {
  revalidatePathIfRequestScoped("/radar");
  revalidatePathIfRequestScoped("/dashboard");
}

/**
 * The page's data. A first visit builds the list inline (bounded, no AI) so nobody lands
 * on an empty page; a list older than a day is rebuilt after the response.
 */
export const fetchRadar = defineAction(
  { auth: () => requireUserForReleasedSurface(SURFACE) },
  async (userId): Promise<{ page: RadarPageData; networkStats: NetworkStats | null }> => {
    await ensureRadarRun(userId).catch(() => false);
    after(() => maybeRefreshRadar(userId).catch(() => undefined));
    const { getNetworkStats } = await import("@/lib/network-stats");
    const [page, networkStats] = await Promise.all([
      loadRadarPage(userId),
      getNetworkStats(userId).catch(() => null),
    ]);
    const shown = page.recommendations.map((r) => r.id);
    after(() => markRecommendationsSeen(userId, shown).catch(() => undefined));
    // The zone Radar's Monday email is timed by: the browser's, as the cookie last reported it.
    const tz = (await cookies()).get(TZ_COOKIE)?.value;
    after(() => captureRadarTimeZone(userId, tz).catch(() => undefined));
    return { page, networkStats };
  }
);

/**
 * The dashboard's morning briefing. Never blocks the dashboard on a build: an account that
 * has never run gets its first build after the response and keeps the legacy card until then.
 */
export const fetchRadarBriefing = defineAction(
  { auth: () => requireUserForReleasedSurface(SURFACE) },
  async (userId): Promise<RadarBriefing> => {
    const briefing = await loadRadarBriefing(userId);
    const shown = briefing.top.map((r) => r.id);
    after(() => markRecommendationsSeen(userId, shown).catch(() => undefined));
    after(() =>
      (briefing.hasRun ? maybeRefreshRadar(userId) : ensureRadarRun(userId).then(() => undefined)).catch(() => undefined)
    );
    return briefing;
  }
);

export type RadarActionResult = { ok: true; message?: string } | { ok: false; message: string };

export const scheduleFromRecommendation = defineAction(
  { auth: () => requireUserForReleasedSurface(SURFACE), schema: z.tuple([z.string(), z.union([z.literal(3), z.literal(7), z.literal(14)])]), invalid: failMessage },
  async (userId, id: string, days: ScheduleDays): Promise<RadarActionResult> => {
    if (!SCHEDULE_DAYS.includes(days)) return { ok: false, message: "Pick 3, 7 or 14 days" };
    const result = await scheduleRecommendationForUser(userId, id, days);
    if (!result.ok) return { ok: false, message: "That card has already changed — refresh to see the latest" };
    revalidateReminderPaths(result.contactId);
    revalidateRadar();
    return { ok: true };
  }
);

export const snoozeRecommendation = defineAction(
  { auth: () => requireUserForReleasedSurface(SURFACE), schema: z.tuple([z.string(), z.enum(["1w", "1m"])]), invalid: failMessage },
  async (userId, id: string, length: SnoozeLength): Promise<RadarActionResult> => {
    if (!(length in SNOOZE_DAYS)) return { ok: false, message: "Pick a week or a month" };
    const result = await snoozeRecommendationForUser(userId, id, length);
    revalidateRadar();
    return result.ok ? { ok: true } : { ok: false, message: "That card has already changed — refresh to see the latest" };
  }
);

export const dismissRecommendation = defineAction(
  { auth: () => requireUserForReleasedSurface(SURFACE), schema: z.tuple([z.string()]), invalid: failMessage },
  async (userId, id: string): Promise<RadarActionResult> => {
    const result = await dismissRecommendationForUser(userId, id);
    revalidateRadar();
    return result.ok ? { ok: true } : { ok: false, message: "That card has already changed — refresh to see the latest" };
  }
);

export const neverForContact = defineAction(
  { auth: () => requireUserForReleasedSurface(SURFACE), schema: z.tuple([z.string()]), invalid: failMessage },
  async (userId, id: string): Promise<RadarActionResult> => {
    const result = await neverForContactForUser(userId, id);
    revalidateRadar();
    return result.ok ? { ok: true } : { ok: false, message: "That card has already changed — refresh to see the latest" };
  }
);

export const restoreRecommendation = defineAction(
  { auth: () => requireUserForReleasedSurface(SURFACE), schema: z.tuple([z.string()]) },
  async (userId, id: string): Promise<{ restored: boolean }> => {
    const result = await restoreRecommendationForUser(userId, id);
    revalidateRadar();
    return result;
  }
);

/** "Refresh now": the same run the nightly pass does, inline and rate-limited. */
export const refreshRadarNow = defineAction(
  { auth: () => requireUserForReleasedSurface(SURFACE), invalid: failMessage },
  async (userId): Promise<RadarActionResult> => {
    try {
      await consumeBucket("radarRefresh", userId, RATE_LIMITS.radarRefresh);
    } catch (err) {
      if (isRateLimitedError(err)) return { ok: false, message: err.message };
      throw err;
    }
    if (!(await claimRadarLease(userId))) {
      return { ok: false, message: "Radar is already updating — give it a moment" };
    }
    const stats = await runRadarForUser(userId, { trigger: "manual", ai: true, budgetMs: 20_000 });
    revalidateRadar();
    if (!stats.ok) return { ok: false, message: "Couldn’t update Radar just now — try again in a minute" };
    return {
      ok: true,
      message: stats.recommendations === 0 ? "Nothing needs you right now" : "Radar is up to date",
    };
  }
);

export const explainRecommendationAction = defineAction(
  { auth: () => requireUserForReleasedSurface(SURFACE), schema: z.tuple([z.string()]) },
  async (userId, id: string): Promise<RadarActionResult & { why?: string; opener?: string }> => {
    const result = await explainRecommendation(userId, id);
    if (result.ok) {
      revalidateRadar();
      return { ok: true, why: result.note.why, opener: result.note.opener };
    }
    if (result.reason === "no_key") return { ok: false, message: AI_ACCESS_COPY.key_required };
    if (result.reason === "not_found") return { ok: false, message: "That card has already changed — refresh to see the latest" };
    return { ok: false, message: result.message ?? friendlyError(null, "Couldn’t write that just now — try again?") };
  }
);

/** Undo one autopilot action: the follow-up it set goes, and so does the card. */
export const undoAutopilot = defineAction(
  { auth: () => requireUserForReleasedSurface(SURFACE), schema: z.tuple([z.string()]), invalid: failMessage },
  async (userId, id: string): Promise<RadarActionResult> => {
    const result = await undoAutopilotForUser(userId, id);
    if (!result.ok) return { ok: false, message: "That card has already changed — refresh to see the latest" };
    revalidateReminderPaths();
    revalidateRadar();
    return {
      ok: true,
      message: result.cleared ? "Follow-up removed" : "Card cleared — the follow-up had already changed, so it stays",
    };
  }
);

/** Turn autopilot on or off for one kind of card. Autopilot schedules; it never sends. */
export const setRadarAutopilot = defineAction(
  { auth: () => requireUserForReleasedSurface(SURFACE), schema: z.tuple([z.enum(["prep", "heads_up", "follow_up", "opportunity", "reach_out", "reconnect"]), z.boolean()]), invalid: failMessage },
  async (userId, kind: RecommendationKind, on: boolean): Promise<RadarActionResult> => {
    if (!RECOMMENDATION_KINDS.includes(kind)) return { ok: false, message: "That isn’t a kind of card Radar makes" };
    const db = await getDb();
    await db
      .update(userSettings)
      .set({ radarAutopilot: sql`coalesce(${userSettings.radarAutopilot}, '{}'::jsonb) || ${JSON.stringify({ [kind]: on === true })}::jsonb` })
      .where(eq(userSettings.userId, userId));
    revalidateRadar();
    return { ok: true, message: on ? `Autopilot on for ${KIND_LABELS[kind]}` : `Autopilot off for ${KIND_LABELS[kind]}` };
  }
);

export const setRadarPaused = defineAction(
  { auth: () => requireUserForReleasedSurface(SURFACE), schema: z.tuple([z.boolean()]), invalid: failMessage },
  async (userId, paused: boolean): Promise<RadarActionResult> => {
    const db = await getDb();
    await db.update(userSettings).set({ radarPaused: paused ? 1 : 0 }).where(eq(userSettings.userId, userId));
    revalidateRadar();
    return { ok: true, message: paused ? "Radar paused" : "Radar resumed" };
  }
);

/** Radar's Monday email on or off. Also reachable from Settings and the email's own link. */
export const setRadarDigest = defineAction(
  { auth: () => requireUserForReleasedSurface(SURFACE), schema: z.tuple([z.boolean()]), invalid: failMessage },
  async (userId, on: boolean): Promise<RadarActionResult> => {
    const db = await getDb();
    await db.update(userSettings).set({ radarDigestEnabled: on ? 1 : 0 }).where(eq(userSettings.userId, userId));
    revalidateRadar();
    revalidatePathIfRequestScoped("/settings");
    return { ok: true, message: on ? "Monday email on" : "Monday email off" };
  }
);

/** Whether the extension may save LinkedIn posts by known contacts as Radar activity. */
export const setRadarCaptureLinkedin = defineAction(
  { auth: () => requireUserForReleasedSurface(SURFACE), schema: z.tuple([z.boolean()]), invalid: failMessage },
  async (userId, on: boolean): Promise<RadarActionResult> => {
    const db = await getDb();
    await db.update(userSettings).set({ radarCaptureLinkedinActivity: on ? 1 : 0 }).where(eq(userSettings.userId, userId));
    revalidateRadar();
    return { ok: true, message: on ? "The extension can save LinkedIn posts to Radar" : "LinkedIn post saving off" };
  }
);
