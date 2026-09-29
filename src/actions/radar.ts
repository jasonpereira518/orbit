"use server";

/**
 * The `/radar` page's server actions. Each derives the user from the session and checks
 * the surface first (`requireUserForSurface`), then calls the request-free functions in
 * `src/lib/radar/actions-core.ts`, so the smoke drives the same code.
 */
import { after } from "next/server";
import { friendlyError } from "@/lib/errors";
import { requireUserForSurface } from "@/lib/plan-guards";
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
import { loadRadarPage, type RadarPageData } from "@/lib/radar/page-data";
import { claimRadarLease, ensureRadarRun, maybeRefreshRadar, runRadarForUser } from "@/lib/radar/run";
import { getDb } from "@/db";
import { userSettings } from "@/db/schema";
import { eq } from "drizzle-orm";
import type { NetworkStats } from "@/lib/network-stats";

const SURFACE = "page.radar";

function revalidateRadar() {
  revalidatePathIfRequestScoped("/radar");
  revalidatePathIfRequestScoped("/dashboard");
}

/**
 * The page's data. A first visit builds the list inline (bounded, no AI) so nobody lands
 * on an empty page; a list older than a day is rebuilt after the response.
 */
export async function fetchRadar(): Promise<{ page: RadarPageData; networkStats: NetworkStats | null }> {
  const userId = await requireUserForSurface(SURFACE);
  await ensureRadarRun(userId).catch(() => false);
  after(() => maybeRefreshRadar(userId).catch(() => undefined));
  const { getNetworkStats } = await import("@/lib/network-stats");
  const [page, networkStats] = await Promise.all([
    loadRadarPage(userId),
    getNetworkStats(userId).catch(() => null),
  ]);
  return { page, networkStats };
}

export type RadarActionResult = { ok: true; message?: string } | { ok: false; message: string };

export async function scheduleFromRecommendation(id: string, days: ScheduleDays): Promise<RadarActionResult> {
  const userId = await requireUserForSurface(SURFACE);
  if (!SCHEDULE_DAYS.includes(days)) return { ok: false, message: "Pick 3, 7 or 14 days" };
  const result = await scheduleRecommendationForUser(userId, id, days);
  if (!result.ok) return { ok: false, message: "That card has already changed — refresh to see the latest" };
  revalidateReminderPaths(result.contactId);
  revalidateRadar();
  return { ok: true };
}

export async function snoozeRecommendation(id: string, length: SnoozeLength): Promise<RadarActionResult> {
  const userId = await requireUserForSurface(SURFACE);
  if (!(length in SNOOZE_DAYS)) return { ok: false, message: "Pick a week or a month" };
  const result = await snoozeRecommendationForUser(userId, id, length);
  revalidateRadar();
  return result.ok ? { ok: true } : { ok: false, message: "That card has already changed — refresh to see the latest" };
}

export async function dismissRecommendation(id: string): Promise<RadarActionResult> {
  const userId = await requireUserForSurface(SURFACE);
  const result = await dismissRecommendationForUser(userId, id);
  revalidateRadar();
  return result.ok ? { ok: true } : { ok: false, message: "That card has already changed — refresh to see the latest" };
}

export async function neverForContact(id: string): Promise<RadarActionResult> {
  const userId = await requireUserForSurface(SURFACE);
  const result = await neverForContactForUser(userId, id);
  revalidateRadar();
  return result.ok ? { ok: true } : { ok: false, message: "That card has already changed — refresh to see the latest" };
}

export async function restoreRecommendation(id: string): Promise<{ restored: boolean }> {
  const userId = await requireUserForSurface(SURFACE);
  const result = await restoreRecommendationForUser(userId, id);
  revalidateRadar();
  return result;
}

/** "Refresh now": the same run the nightly pass does, inline and rate-limited. */
export async function refreshRadarNow(): Promise<RadarActionResult> {
  const userId = await requireUserForSurface(SURFACE);
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

export async function explainRecommendationAction(id: string): Promise<RadarActionResult & { why?: string; opener?: string }> {
  const userId = await requireUserForSurface(SURFACE);
  const result = await explainRecommendation(userId, id);
  if (result.ok) {
    revalidateRadar();
    return { ok: true, why: result.note.why, opener: result.note.opener };
  }
  if (result.reason === "no_key") return { ok: false, message: "Add your AI API key in Settings to use this" };
  if (result.reason === "not_found") return { ok: false, message: "That card has already changed — refresh to see the latest" };
  return { ok: false, message: result.message ?? friendlyError(null, "Couldn’t write that just now — try again?") };
}

export async function setRadarPaused(paused: boolean): Promise<RadarActionResult> {
  const userId = await requireUserForSurface(SURFACE);
  const db = await getDb();
  await db.update(userSettings).set({ radarPaused: paused ? 1 : 0 }).where(eq(userSettings.userId, userId));
  revalidateRadar();
  return { ok: true, message: paused ? "Radar paused" : "Radar resumed" };
}
