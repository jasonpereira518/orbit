"use server";

/**
 * The `/radar` page's server actions. Each derives the user from the session and checks
 * the surface first (`requireUserForReleasedSurface`), then calls the request-free functions in
 * `src/lib/radar/actions-core.ts`, so the smoke drives the same code.
 */
import { cookies, headers } from "next/headers";
import { parsePushSubscription, removePushSubscription, savePushSubscription } from "@/lib/push";
import { after } from "next/server";
import { addInboxPersonForUser, dismissInboxPersonForUser } from "@/lib/email-intel/inbox-actions";
import { reconcileEmailChunkContacts } from "@/lib/email-intel/search-index";
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
import {
  loadRadarActivation,
  loadRadarBriefing,
  loadRadarPage,
  type RadarActivation,
  type RadarBriefing,
  type RadarPageData,
} from "@/lib/radar/page-data";
import { claimRadarLease, ensureRadarRun, loadRadarState, maybeRefreshRadar, refreshRadarForNewContact, runRadarForUser, turnOnRadarForUser } from "@/lib/radar/run";
import { rebuildContactEmbedding } from "@/lib/search";
import { markRecommendationsSeen, stampRadarOpened } from "@/lib/radar/store";
import { getDb } from "@/db";
import { userSettings } from "@/db/schema";
import { eq } from "drizzle-orm";
import { setRadarAutopilotForUser, undoAutopilotForUser } from "@/lib/radar/autopilot";
import { captureRadarTimeZone } from "@/lib/radar/digest";
import { TZ_COOKIE } from "@/lib/reminder-due-bucket";
import { AUTOPILOT_KINDS, KIND_LABELS, isRadarDismissReason, type RecommendationKind } from "@/lib/radar/types";
import { dismissOpportunityForUser, saveOpportunityForUser } from "@/lib/radar/opportunity-actions";
import type { NetworkStats } from "@/lib/network-stats";

const SURFACE = "page.radar";

function revalidateRadar() {
  revalidatePathIfRequestScoped("/radar");
  revalidatePathIfRequestScoped("/dashboard");
}

/** Is Radar on for this account, and if not, the people the turn-on scene draws. Builds nothing. */
export async function fetchRadarActivation(): Promise<RadarActivation> {
  const userId = await requireUserForReleasedSurface(SURFACE);
  return loadRadarActivation(userId);
}

/**
 * The page's data. A first visit builds the list inline (bounded, no AI) so nobody lands
 * on an empty page; a list older than a day is rebuilt after the response.
 */
export async function fetchRadar(): Promise<{ page: RadarPageData; networkStats: NetworkStats | null }> {
  const userId = await requireUserForReleasedSurface(SURFACE);
  await ensureRadarRun(userId).catch(() => false);
  after(() => maybeRefreshRadar(userId).catch(() => undefined));
  const { getNetworkStats } = await import("@/lib/network-stats");
  const [page, networkStats] = await Promise.all([
    loadRadarPage(userId),
    getNetworkStats(userId).catch(() => null),
  ]);
  const shown = page.recommendations.map((r) => r.id);
  after(() => markRecommendationsSeen(userId, shown).catch(() => undefined));
  // Opening the page is what clears the nav's green "new suggestions" pulse.
  after(() => stampRadarOpened(userId).catch(() => undefined));
  // The zone Radar's Monday email is timed by: the browser's, as the cookie last reported it.
  const tz = (await cookies()).get(TZ_COOKIE)?.value;
  after(() => captureRadarTimeZone(userId, tz).catch(() => undefined));
  return { page, networkStats };
}

/**
 * The dashboard's morning briefing. Never blocks the dashboard on a build: an account that
 * has never run gets its first build after the response and keeps the legacy card until then.
 */
export async function fetchRadarBriefing(): Promise<RadarBriefing> {
  const userId = await requireUserForReleasedSurface(SURFACE);
  const briefing = await loadRadarBriefing(userId);
  const shown = briefing.top.map((r) => r.id);
  after(() => markRecommendationsSeen(userId, shown).catch(() => undefined));
  after(() =>
    (briefing.hasRun ? maybeRefreshRadar(userId) : ensureRadarRun(userId).then(() => undefined)).catch(() => undefined)
  );
  return briefing;
}

/** `busy`: a run is already under way, so the page shows its progress instead of an error. */
export type RadarActionResult = { ok: true; message?: string } | { ok: false; message: string; busy?: true };

export async function scheduleFromRecommendation(id: string, days: ScheduleDays): Promise<RadarActionResult> {
  const userId = await requireUserForReleasedSurface(SURFACE);
  if (!SCHEDULE_DAYS.includes(days)) return { ok: false, message: "Pick 3, 7 or 14 days" };
  const result = await scheduleRecommendationForUser(userId, id, days);
  if (!result.ok) return { ok: false, message: "That card has already changed — refresh to see the latest" };
  revalidateReminderPaths(result.contactId);
  revalidateRadar();
  return { ok: true };
}

export async function snoozeRecommendation(id: string, length: SnoozeLength): Promise<RadarActionResult> {
  const userId = await requireUserForReleasedSurface(SURFACE);
  if (!(length in SNOOZE_DAYS)) return { ok: false, message: "Pick a week or a month" };
  const result = await snoozeRecommendationForUser(userId, id, length);
  revalidateRadar();
  return result.ok ? { ok: true } : { ok: false, message: "That card has already changed — refresh to see the latest" };
}

export async function dismissRecommendation(id: string, reason?: string | null): Promise<RadarActionResult> {
  const userId = await requireUserForReleasedSurface(SURFACE);
  const result = await dismissRecommendationForUser(userId, id, isRadarDismissReason(reason) ? reason : null);
  revalidateRadar();
  return result.ok ? { ok: true } : { ok: false, message: "That card has already changed — refresh to see the latest" };
}

export async function neverForContact(id: string): Promise<RadarActionResult> {
  const userId = await requireUserForReleasedSurface(SURFACE);
  const result = await neverForContactForUser(userId, id);
  revalidateRadar();
  return result.ok ? { ok: true } : { ok: false, message: "That card has already changed — refresh to see the latest" };
}

export async function restoreRecommendation(id: string): Promise<{ restored: boolean }> {
  const userId = await requireUserForReleasedSurface(SURFACE);
  const result = await restoreRecommendationForUser(userId, id);
  revalidateRadar();
  return result;
}

/**
 * "Add to Orbit" on a person the strip offered. The key is all the client sends: the contact is
 * built from the stored event (`addInboxPersonForUser`). Radar then updates, bounded, so the
 * cards the new contact makes possible are there when the page redraws.
 */
export async function addInboxPerson(key: string): Promise<RadarActionResult & { contactId?: string }> {
  const userId = await requireUserForReleasedSurface(SURFACE);
  const result = await addInboxPersonForUser(userId, key);
  if (!result.ok) return { ok: false, message: result.message };
  after(() => rebuildContactEmbedding(userId, result.contactId).catch(() => undefined));
  // The new contact is named in emails already indexed for chat: make them findable from this person.
  after(() => reconcileEmailChunkContacts(userId).catch(() => undefined));
  await refreshRadarForNewContact(userId).catch(() => false);
  revalidatePathIfRequestScoped("/contacts");
  revalidatePathIfRequestScoped("/graph");
  revalidateRadar();
  return {
    ok: true,
    contactId: result.contactId,
    message: result.created ? `${result.name} is in your orbit` : `${result.name} was already in your orbit`,
  };
}

/** "Dismiss" on the strip: not offered again. They stay on Capture's Ignored people list if you change your mind. */
export async function dismissInboxPerson(key: string): Promise<RadarActionResult> {
  const userId = await requireUserForReleasedSurface(SURFACE);
  await dismissInboxPersonForUser(userId, key);
  revalidateRadar();
  return { ok: true, message: "Dismissed. You can still add them from Ignored people on Capture" };
}

/** Keep a find from the Opportunities lane: an event, a contact or a reminder, by its kind. */
export async function saveRadarOpportunity(id: string): Promise<RadarActionResult & { href?: string }> {
  const userId = await requireUserForReleasedSurface(SURFACE);
  try {
    const result = await saveOpportunityForUser(userId, id);
    if (!result.ok) return result;
    if (result.kind === "event") revalidatePathIfRequestScoped("/events");
    const contactId = result.contactId;
    if (contactId) {
      after(() => rebuildContactEmbedding(userId, contactId).catch(() => undefined));
      revalidatePathIfRequestScoped("/contacts");
    }
    if (result.kind === "program") revalidatePathIfRequestScoped("/reminders");
    revalidateRadar();
    return { ok: true, message: result.message, href: result.href };
  } catch (err) {
    return { ok: false, message: friendlyError(err, "Couldn’t save that just now — try again?") };
  }
}

export async function dismissRadarOpportunity(id: string, reason?: string | null): Promise<RadarActionResult> {
  const userId = await requireUserForReleasedSurface(SURFACE);
  const result = await dismissOpportunityForUser(userId, id, isRadarDismissReason(reason) ? reason : null);
  revalidateRadar();
  return result.ok ? { ok: true } : { ok: false, message: "That find has already changed — refresh to see the latest" };
}

/** "Refresh now": the same run the nightly pass does, inline and rate-limited. */
export async function refreshRadarNow(): Promise<RadarActionResult> {
  const userId = await requireUserForReleasedSurface(SURFACE);
  try {
    await consumeBucket("radarRefresh", userId, RATE_LIMITS.radarRefresh);
  } catch (err) {
    if (isRateLimitedError(err)) return { ok: false, message: err.message };
    throw err;
  }
  const state = await loadRadarState(userId);
  if (!state || state.paused) return { ok: false, message: "Turn on Radar first" };
  if (!(await claimRadarLease(userId))) {
    return { ok: false, message: "Radar is already updating", busy: true };
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
  const userId = await requireUserForReleasedSurface(SURFACE);
  const result = await explainRecommendation(userId, id);
  if (result.ok) {
    revalidateRadar();
    return { ok: true, why: result.note.why, opener: result.note.opener };
  }
  if (result.reason === "no_key") return { ok: false, message: AI_ACCESS_COPY.key_required };
  if (result.reason === "not_found") return { ok: false, message: "That card has already changed — refresh to see the latest" };
  return { ok: false, message: result.message ?? friendlyError(null, "Couldn’t write that just now — try again?") };
}

/** Undo one autopilot action: the follow-up it set goes, and so does the card. */
export async function undoAutopilot(id: string): Promise<RadarActionResult> {
  const userId = await requireUserForReleasedSurface(SURFACE);
  const result = await undoAutopilotForUser(userId, id);
  if (!result.ok) return { ok: false, message: "That card has already changed — refresh to see the latest" };
  revalidateReminderPaths();
  revalidateRadar();
  return {
    ok: true,
    message: result.cleared ? "Follow-up removed" : "Card cleared — the follow-up had already changed, so it stays",
  };
}

/** Turn autopilot on or off for one kind of card. Autopilot schedules; it never sends. */
export async function setRadarAutopilot(kind: RecommendationKind, on: boolean): Promise<RadarActionResult> {
  const userId = await requireUserForReleasedSurface(SURFACE);
  if (!(AUTOPILOT_KINDS as readonly string[]).includes(kind)) return { ok: false, message: "Autopilot doesn’t run on that kind of card" };
  await setRadarAutopilotForUser(userId, kind, on);
  revalidateRadar();
  return { ok: true, message: on ? `Autopilot on for ${KIND_LABELS[kind]}` : `Autopilot off for ${KIND_LABELS[kind]}` };
}

/**
 * "Turn on Radar". Radar is off by default (schema v225): this stamps the first time it was
 * turned on (kept forever, so a later turn-on plays the short animation), clears a pause, and
 * builds the first plan with AI after the response, while the animation plays.
 */
export async function turnOnRadar(): Promise<RadarActionResult> {
  const userId = await requireUserForReleasedSurface(SURFACE);
  await turnOnRadarForUser(userId);
  after(async () => {
    if (await claimRadarLease(userId).catch(() => false)) {
      await runRadarForUser(userId, { trigger: "manual", ai: true, budgetMs: 60_000 }).catch(() => undefined);
    }
  });
  // No revalidation here on purpose: it would re-render /radar as "on" in this action's own
  // response and unmount the turn-on animation mid-play. The client refreshes when it lands.
  return { ok: true, message: "Radar is on" };
}

export async function setRadarPaused(paused: boolean): Promise<RadarActionResult> {
  const userId = await requireUserForReleasedSurface(SURFACE);
  const db = await getDb();
  await db.update(userSettings).set({ radarPaused: paused ? 1 : 0 }).where(eq(userSettings.userId, userId));
  revalidateRadar();
  return { ok: true, message: paused ? "Radar is off" : "Radar is on" };
}

/** Radar's Monday email on or off. Also reachable from Settings and the email's own link. */
export async function setRadarDigest(on: boolean): Promise<RadarActionResult> {
  const userId = await requireUserForReleasedSurface(SURFACE);
  const db = await getDb();
  await db.update(userSettings).set({ radarDigestEnabled: on ? 1 : 0 }).where(eq(userSettings.userId, userId));
  revalidateRadar();
  revalidatePathIfRequestScoped("/settings");
  return { ok: true, message: on ? "Monday email on" : "Monday email off" };
}

/** The same-day email Radar sends when a Today item won't keep (at most one a day). */
export async function setRadarMomentEmail(on: boolean): Promise<RadarActionResult> {
  const userId = await requireUserForReleasedSurface(SURFACE);
  const db = await getDb();
  await db.update(userSettings).set({ radarMomentEmailEnabled: on ? 1 : 0 }).where(eq(userSettings.userId, userId));
  revalidateRadar();
  return { ok: true, message: on ? "Same-day email on" : "Same-day email off" };
}

/** "Turn on" push for this browser: the subscription the browser just made, saved for the account. */
export async function saveRadarPushSubscription(raw: unknown): Promise<RadarActionResult> {
  const userId = await requireUserForReleasedSurface(SURFACE);
  const target = parsePushSubscription(raw);
  if (!target) return { ok: false, message: "This browser gave Orbit a subscription it can’t use — try again?" };
  const ua = (await headers()).get("user-agent");
  await savePushSubscription(userId, target, ua);
  return { ok: true, message: "Push on for this device" };
}

export async function removeRadarPushSubscription(endpoint: string): Promise<RadarActionResult> {
  const userId = await requireUserForReleasedSurface(SURFACE);
  if (typeof endpoint !== "string" || endpoint.length > 1000) return { ok: false, message: "Couldn’t turn that off — try again?" };
  await removePushSubscription(userId, endpoint);
  return { ok: true, message: "Push off for this device" };
}

/** Whether the extension may save LinkedIn posts by known contacts as Radar activity. */
export async function setRadarCaptureLinkedin(on: boolean): Promise<RadarActionResult> {
  const userId = await requireUserForReleasedSurface(SURFACE);
  const db = await getDb();
  await db.update(userSettings).set({ radarCaptureLinkedinActivity: on ? 1 : 0 }).where(eq(userSettings.userId, userId));
  revalidateRadar();
  return { ok: true, message: on ? "The extension can save LinkedIn posts to Radar" : "LinkedIn post saving off" };
}

/** 1-click confirmation of a suggested calendar invite from a Radar card */
export async function confirmCalendarInvite(
  recommendationId: string,
  overrides?: { startTime?: string; title?: string; agenda?: string }
): Promise<RadarActionResult & { eventId?: string }> {
  const userId = await requireUserForReleasedSurface(SURFACE);
  const { confirmCalendarInviteFromRecommendation } = await import("@/lib/radar/invites");
  const result = await confirmCalendarInviteFromRecommendation(userId, recommendationId, overrides);
  if (result.ok) {
    revalidateReminderPaths();
    revalidateRadar();
  }
  return result;
}

/** Toggles the 5:00 AM daily pass on or off */
export async function setRadarDailyEnabled(enabled: boolean): Promise<RadarActionResult> {
  const userId = await requireUserForReleasedSurface(SURFACE);
  const db = await getDb();
  await db.update(userSettings).set({ radarDailyEnabled: enabled ? 1 : 0 }).where(eq(userSettings.userId, userId));
  revalidateRadar();
  return { ok: true, message: enabled ? "Daily 5:00 AM Radar enabled" : "Daily 5:00 AM Radar disabled" };
}
