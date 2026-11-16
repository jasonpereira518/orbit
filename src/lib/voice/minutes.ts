/**
 * Cosmo's minutes: how long calls ran, summed from `orbit_voice_sessions` (no meter table).
 * A call counts from `connected_at` to when it ended, or, while live, to its last heartbeat,
 * never past its own `expires_at`. Calls that never connected cost nothing (the provider never
 * opened a conversation).
 *
 * Server-only, and loaded lazily by sessions.ts: a static import there puts it in every page's
 * server-action graph (the next dev reload-loop trap).
 */
import { and, gte, eq, isNotNull, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { orbitVoiceSessions } from "@/db/schema";
import { getEntitlements } from "@/lib/entitlements";
import { getEffectivePlanConfig } from "@/lib/plans/plan-rules";
import { monthWindow } from "@/lib/speech-limits";
import { PLAN_LABELS, type Plan } from "@/lib/plans/plan-config";

const talked = sql<number>`coalesce(sum(extract(epoch from (least(coalesce(${orbitVoiceSessions.endedAt}, ${orbitVoiceSessions.lastSeenAt}, ${orbitVoiceSessions.connectedAt}), ${orbitVoiceSessions.expiresAt}) - ${orbitVoiceSessions.connectedAt}))), 0)`;

async function secondsSince(since: Date, userId?: string): Promise<number> {
  const db = await getDb();
  const rows = await db
    .select({ seconds: talked })
    .from(orbitVoiceSessions)
    .where(
      and(
        isNotNull(orbitVoiceSessions.connectedAt),
        gte(orbitVoiceSessions.connectedAt, since),
        userId ? eq(orbitVoiceSessions.userId, userId) : undefined,
      ),
    );
  return Math.max(0, Number(rows[0]?.seconds ?? 0));
}

export type VoiceMinutes = { plan: Plan; limit: number; used: number; remaining: number; resetsAt: Date };

/** This month's Cosmo allowance for one person (UTC month, like the other speech meters). */
export async function voiceMinutes(userId: string, now = new Date()): Promise<VoiceMinutes> {
  const { start, resetsAt } = monthWindow(now);
  const [entitlements, config, used] = await Promise.all([
    getEntitlements(userId),
    getEffectivePlanConfig(),
    secondsSince(start, userId),
  ]);
  const limit = config[entitlements.plan].speech.assistantSeconds;
  return { plan: entitlements.plan, limit, used, remaining: Math.max(0, limit - used), resetsAt };
}

/** Seconds every account has talked today (UTC), against the admin's daily budget. */
export function voiceSecondsToday(now = new Date()): Promise<number> {
  return secondsSince(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())));
}

const UPGRADE: Partial<Record<Plan, Plan>> = { free: "orbit", orbit: "max" };
const mins = (seconds: number) => `${Math.round(seconds / 60)} minute${Math.round(seconds / 60) === 1 ? "" : "s"}`;

/** What a refused start says: whose limit, when it comes back, and what a bigger plan includes. */
export async function voiceRefusal(why: "allowance" | "budget", m: VoiceMinutes): Promise<string> {
  if (why === "budget") return "Cosmo is resting for the day. Try again tomorrow.";
  const when = m.resetsAt.toLocaleDateString("en-US", { month: "long", day: "numeric", timeZone: "UTC" });
  const base = m.limit > 0
    ? `You've used this month's ${mins(m.limit)} with Cosmo. They come back on ${when}.`
    : "Talking with Cosmo isn't included in your plan.";
  const next = UPGRADE[m.plan];
  if (!next) return base;
  const more = (await getEffectivePlanConfig())[next].speech.assistantSeconds;
  return more > m.limit ? `${base} ${PLAN_LABELS[next]} includes ${mins(more)} a month.` : base;
}
