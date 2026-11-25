/**
 * Radar v2 Play Execution & Steering Persistence.
 *
 * Supports multi-step opportunity workflows:
 *   - Double-Opt-In Introductions (draft opt-in → awaiting opt-in + 4d nudge → draft intro)
 *   - Track Opportunity (promote a Radar recommendation or web find into `contact_opportunities`)
 *   - Radar Steering (save user-configured topics, target roles/orgs, avoid list, cadence mode)
 */
import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { contactOpportunities, contacts, radarOpportunities, recommendations, userSettings } from "@/db/schema";
import { cleanSingleLine } from "@/lib/ai-security";
import { parsePersonTitle } from "@/lib/radar/person-title";
import { recordFeedback } from "@/lib/radar/store";
import type { RadarPlayState, RadarSteering } from "@/lib/radar/types";
import { scheduleContactFollowUpForUser } from "@/lib/reminder-writes";
import { resolveOrCreateContact } from "@/lib/contact-resolve";
import { isLinkedInProfileUrl } from "@/lib/contact-input";

const DAY_MS = 86_400_000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function cleanTags(values: unknown, maxItems = 10, maxLen = 60): string[] {
  if (!Array.isArray(values)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of values) {
    const clean = cleanSingleLine(typeof raw === "string" ? raw : null, maxLen);
    if (!clean) continue;
    const key = clean.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(clean);
    if (out.length >= maxItems) break;
  }
  return out;
}

export function sanitizeRadarSteering(input: unknown): RadarSteering {
  if (!input || typeof input !== "object") return {};
  const raw = input as Record<string, unknown>;
  const cadenceMode = raw.cadenceMode === "weekly" ? "weekly" : "reactive";
  const horizonDays = typeof raw.horizonDays === "number" && Number.isFinite(raw.horizonDays)
    ? Math.max(7, Math.min(90, Math.round(raw.horizonDays)))
    : undefined;
  return {
    topics: cleanTags(raw.topics, 12, 60),
    targetRoles: cleanTags(raw.targetRoles, 8, 60),
    targetOrgs: cleanTags(raw.targetOrgs, 10, 80),
    avoidTopics: cleanTags(raw.avoidTopics, 10, 60),
    ...(horizonDays !== undefined ? { horizonDays } : {}),
    cadenceMode,
  };
}

export async function saveRadarSteeringForUser(userId: string, input: unknown): Promise<RadarSteering> {
  const clean = sanitizeRadarSteering(input);
  const db = await getDb();
  await db
    .insert(userSettings)
    .values({ userId, radarSteering: clean })
    .onConflictDoUpdate({
      target: userSettings.userId,
      set: { radarSteering: clean, updatedAt: new Date() },
    });
  return clean;
}

/**
 * Transitions a Connect / Introduce card's double-opt-in workflow.
 * - `"awaiting_opt_in"`: user sent the permission ask; schedules a 4-day check-in nudge and keeps the card pinned.
 * - `"draft_intro"`: consent confirmed; advances UI to draft the intro to the other party.
 * - `"completed"`: intro sent; marks recommendation `accepted` and records positive feedback.
 */
export async function advanceDoubleOptInIntroForUser(
  userId: string,
  recommendationId: string,
  step: RadarPlayState["step"],
  now: Date = new Date()
): Promise<{ ok: true; playState: RadarPlayState } | { ok: false; message: string }> {
  if (!UUID_RE.test(recommendationId)) return { ok: false, message: "Invalid recommendation" };
  const db = await getDb();
  const [rec] = await db
    .select({
      id: recommendations.id,
      contactId: recommendations.contactId,
      secondaryContactId: recommendations.secondaryContactId,
      kind: recommendations.kind,
      status: recommendations.status,
      playState: recommendations.playState,
    })
    .from(recommendations)
    .where(and(eq(recommendations.id, recommendationId), eq(recommendations.userId, userId)))
    .limit(1);

  if (!rec || rec.status !== "pending") {
    return { ok: false, message: "That card has already changed — refresh to see the latest" };
  }

  let secondaryName = rec.playState?.secondaryContactName;
  if (!secondaryName && rec.secondaryContactId) {
    const [c2] = await db
      .select({ fullName: contacts.fullName, preferredName: contacts.preferredName })
      .from(contacts)
      .where(and(eq(contacts.id, rec.secondaryContactId), eq(contacts.userId, userId)))
      .limit(1);
    if (c2) secondaryName = (c2.preferredName ?? "").trim() || c2.fullName;
  }

  const nextState: RadarPlayState = {
    step,
    secondaryContactId: rec.secondaryContactId ?? rec.playState?.secondaryContactId,
    secondaryContactName: secondaryName,
    optInSentAt: step === "awaiting_opt_in" ? now.toISOString() : rec.playState?.optInSentAt,
    introSentAt: step === "completed" ? now.toISOString() : rec.playState?.introSentAt,
  };

  if (step === "awaiting_opt_in") {
    await scheduleContactFollowUpForUser(userId, rec.contactId, 4, { origin: "suggestion" }).catch(() => undefined);
    await db
      .update(recommendations)
      .set({
        playState: nextState,
        pinnedUntil: new Date(now.getTime() + 7 * DAY_MS),
        updatedAt: now,
      })
      .where(and(eq(recommendations.id, rec.id), eq(recommendations.userId, userId)));
    return { ok: true, playState: nextState };
  }

  if (step === "draft_intro") {
    await db
      .update(recommendations)
      .set({
        playState: nextState,
        pinnedUntil: new Date(now.getTime() + 7 * DAY_MS),
        updatedAt: now,
      })
      .where(and(eq(recommendations.id, rec.id), eq(recommendations.userId, userId)));
    return { ok: true, playState: nextState };
  }

  // completed
  await db
    .update(recommendations)
    .set({
      playState: nextState,
      status: "accepted",
      actedAt: now,
      resolvedAt: now,
      updatedAt: now,
    })
    .where(and(eq(recommendations.id, rec.id), eq(recommendations.userId, userId)));
  await recordFeedback(userId, {
    contactId: rec.contactId,
    recommendationId: rec.id,
    kind: rec.kind,
    action: "accepted",
  });
  return { ok: true, playState: nextState };
}

/**
 * Promotes a Radar recommendation or web opportunity find into a tracked `contact_opportunities`
 * row (and optional follow-up reminder), closing out the Radar card as accepted/saved.
 */
export async function trackRadarOpportunityForUser(
  userId: string,
  input: { source: "recommendation" | "opportunity"; id: string; dueDays?: number },
  now: Date = new Date()
): Promise<{ ok: true; contactId: string; message: string; href: string } | { ok: false; message: string }> {
  if (!UUID_RE.test(input.id)) return { ok: false, message: "Invalid item" };
  const db = await getDb();
  const dueDays = typeof input.dueDays === "number" ? Math.max(1, Math.min(60, Math.round(input.dueDays))) : 7;
  const dueDate = new Date(now.getTime() + dueDays * DAY_MS);

  if (input.source === "recommendation") {
    const [rec] = await db
      .select()
      .from(recommendations)
      .where(and(eq(recommendations.id, input.id), eq(recommendations.userId, userId)))
      .limit(1);
    if (!rec || rec.status !== "pending") return { ok: false, message: "That card has already changed" };

    const lead = rec.reasons.find((r) => r.points > 0)?.label ?? rec.kind;
    const label = (rec.aiNote?.nextStep || rec.aiNote?.why || lead).slice(0, 160);
    const itemHash = createHash("sha256").update(`radar:rec:${rec.id}`).digest("hex").slice(0, 32);
    const oppKind = rec.kind === "introduce" ? "introduction" : rec.kind === "warm_path" ? "referral" : "collaboration";

    await db
      .insert(contactOpportunities)
      .values({
        userId,
        contactId: rec.contactId,
        kind: oppKind,
        label,
        status: "in_progress",
        direction: "you_ask",
        dueDate,
        itemHash,
      })
      .onConflictDoNothing({ target: [contactOpportunities.userId, contactOpportunities.itemHash] });

    await scheduleContactFollowUpForUser(userId, rec.contactId, dueDays, { origin: "suggestion" }).catch(() => undefined);
    await db
      .update(recommendations)
      .set({ status: "accepted", actedAt: now, resolvedAt: now, updatedAt: now })
      .where(and(eq(recommendations.id, rec.id), eq(recommendations.userId, userId)));
    await recordFeedback(userId, { contactId: rec.contactId, recommendationId: rec.id, kind: rec.kind, action: "accepted" });

    return { ok: true, contactId: rec.contactId, message: "Opportunity tracked", href: `/contacts/${rec.contactId}` };
  }

  // Web opportunity (`radar_opportunities`)
  const [opp] = await db
    .select()
    .from(radarOpportunities)
    .where(and(eq(radarOpportunities.id, input.id), eq(radarOpportunities.userId, userId)))
    .limit(1);
  if (!opp) return { ok: false, message: "Opportunity not found" };

  let targetContactId = opp.relatedContactIds[0] ?? null;
  if (!targetContactId && opp.kind === "person") {
    const p = parsePersonTitle(opp.title);
    const created = await resolveOrCreateContact(
      userId,
      {
        fullName: p.fullName,
        title: p.title ?? undefined,
        company: p.company ?? undefined,
        ...(opp.url && isLinkedInProfileUrl(opp.url) ? { linkedinUrl: opp.url } : { website: opp.url ?? undefined }),
        notes: opp.why ?? undefined,
        source: "radar",
      },
      { skipRevalidate: true }
    );
    targetContactId = created.contactId;
  }

  if (targetContactId) {
    const itemHash = createHash("sha256").update(`radar:opp:${opp.id}`).digest("hex").slice(0, 32);
    await db
      .insert(contactOpportunities)
      .values({
        userId,
        contactId: targetContactId,
        kind: opp.kind === "person" ? "introduction" : "referral",
        label: opp.title.slice(0, 160),
        status: "in_progress",
        direction: "you_ask",
        dueDate: opp.expiresAt && opp.expiresAt > now ? opp.expiresAt : dueDate,
        itemHash,
      })
      .onConflictDoNothing({ target: [contactOpportunities.userId, contactOpportunities.itemHash] });
  }

  await db
    .update(radarOpportunities)
    .set({ status: "saved", actedAt: now, updatedAt: now })
    .where(and(eq(radarOpportunities.id, opp.id), eq(radarOpportunities.userId, userId)));

  return {
    ok: true,
    contactId: targetContactId ?? "",
    message: "Opportunity tracked",
    href: targetContactId ? `/contacts/${targetContactId}` : "/radar",
  };
}
