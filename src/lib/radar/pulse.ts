/**
 * Radar's people check (spec: docs/superpowers/specs/2026-11-10-radar-analyst-design.md, PR 7).
 *
 * The work-history re-check (`checkCurrentRoleWithWebSearch`) is widened to also report recent
 * public posts, talks and news about the person. No extra search: the one search that confirms
 * where someone works now also reads what they have been up to.
 *
 *   - Only a link the search provider actually cited is kept (`keepCitedMentions`); a URL the
 *     model wrote is dropped. That citation is the mention's proof on the card.
 *   - Only accounts with Radar on, and only people they have met (`radarPulseAllowed`).
 *   - At most the plan's `pulsePerMonth` widened checks a month; past it the check asks only
 *     where they work, exactly as before.
 */
import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { contactSignals, userSettings } from "@/db/schema";
import type { WebSource } from "@/lib/ai";
import { cleanSingleLine } from "@/lib/ai-security";
import { resolvePlan } from "@/lib/entitlements";
import { metContactIds } from "@/lib/met-contact";
import { getRadarLimitsForPlan } from "@/lib/plans/plan-config";
import { consumeBucket } from "@/lib/rate-limit";
import { safeHttpUrl } from "@/lib/safe-links";
import type { ContactSignalPayload, MentionKind } from "@/lib/radar/types";

export type Mention = { kind: MentionKind; text: string; url: string; dateIso: string | null };

/** A mention older than this is not news. */
const MENTION_MAX_DAYS = 90;
export const MENTIONS_PER_CHECK = 3;
const TEXT_MAX = 280;
const DAY_MS = 86_400_000;
const MONTH_SEC = 31 * 86_400;
export const RADAR_PULSE_SCOPE = "radar-pulse";

/**
 * The mentions worth keeping: safe, with text, recent (or undated), and on a link the provider
 * cited. Both sides go through `safeHttpUrl`, so a model-written URL never sneaks through on a
 * formatting difference.
 */
export function keepCitedMentions(
  items: ReadonlyArray<{ kind?: unknown; text?: unknown; url?: unknown; dateIso?: unknown }>,
  sources: readonly WebSource[],
  now: Date
): Mention[] {
  const cited = new Set(sources.map((s) => safeHttpUrl(s.url)).filter(Boolean));
  const out: Mention[] = [];
  for (const item of items) {
    const url = safeHttpUrl(typeof item.url === "string" ? item.url : null);
    const text = cleanSingleLine(typeof item.text === "string" ? item.text : null, TEXT_MAX);
    if (!url || !text || !cited.has(url)) continue;
    const date = typeof item.dateIso === "string" ? new Date(item.dateIso) : null;
    const valid = date && !Number.isNaN(date.getTime()) ? date : null;
    if (valid && now.getTime() - valid.getTime() > MENTION_MAX_DAYS * DAY_MS) continue;
    const kind: MentionKind = item.kind === "talk" || item.kind === "news" ? item.kind : "post";
    out.push({ kind, text, url, dateIso: valid ? valid.toISOString() : null });
    if (out.length >= MENTIONS_PER_CHECK) break;
  }
  return out;
}

/**
 * Whether this check may be widened: Radar on, the person met, and the plan's monthly allowance
 * not used up. Spends one unit of the allowance when it says yes. Any failure means "no": the
 * plain role check still runs.
 */
export async function radarPulseAllowed(userId: string, contactId: string, now: Date = new Date()): Promise<boolean> {
  try {
    const db = await getDb();
    const [s] = await db
      .select({
        enabledAt: userSettings.radarEnabledAt,
        paused: userSettings.radarPaused,
        compedPlan: userSettings.compedPlan,
        lifetimePurchasedAt: userSettings.lifetimePurchasedAt,
        subscriptionPlan: userSettings.subscriptionPlan,
        subscriptionStatus: userSettings.subscriptionStatus,
        subscriptionPeriodEnd: userSettings.subscriptionPeriodEnd,
      })
      .from(userSettings)
      .where(eq(userSettings.userId, userId))
      .limit(1);
    if (!s?.enabledAt || s.paused) return false;
    const limit = getRadarLimitsForPlan(resolvePlan(s, now).plan).pulsePerMonth;
    if (limit <= 0) return false;
    if (!(await metContactIds(userId, [contactId])).has(contactId)) return false;
    await consumeBucket(RADAR_PULSE_SCOPE, userId, { limit, windowSec: MONTH_SEC });
    return true;
  } catch {
    return false;
  }
}

/** Store kept mentions as `web_mention` signals, once per link. Returns how many were new. */
export async function storeMentions(userId: string, contactId: string, mentions: readonly Mention[], now: Date = new Date()): Promise<number> {
  if (mentions.length === 0) return 0;
  const db = await getDb();
  const inserted = await db
    .insert(contactSignals)
    .values(
      mentions.map((m) => ({
        userId,
        contactId,
        kind: "web_mention" as const,
        occurredAt: m.dateIso ? new Date(m.dateIso) : now,
        source: "web",
        payload: { excerpt: m.text, url: m.url, mentionKind: m.kind } satisfies ContactSignalPayload,
        dedupeHash: createHash("sha256").update(`mention:${contactId}:${m.url}`).digest("hex"),
      }))
    )
    .onConflictDoNothing({ target: [contactSignals.userId, contactSignals.dedupeHash] })
    .returning();
  return inserted.length;
}
