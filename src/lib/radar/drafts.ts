/**
 * Drafts written overnight for the cards a person will see first, so acting on one is
 * review-and-send rather than a blank page.
 *
 * Only on the account's own key, only for Today's cards of the kinds a message answers
 * (reach out, reconnect, follow up, heads-up), and at most `RADAR_DRAFTS_PER_RUN` a night,
 * inside the run's shared AI deadline. The prompt is the one the draft sheet uses
 * (`generateContactFollowUpDraft`), told why the card exists. A draft is kept while the
 * card's facts (`inputs_hash`) are unchanged, so an unchanged night costs nothing.
 *
 * Nothing here sends anything. The draft is text on the card until the person opens it.
 */
import { and, eq, sql } from "drizzle-orm";
import { getDb, rowsOf } from "@/db";
import { recommendations } from "@/db/schema";
import type { AiAccess } from "@/lib/ai-access";
import { guardModelOutput } from "@/lib/ai-security";
import { generateContactFollowUpDraft } from "@/lib/follow-up-drafts";
import { reportUnlessQuiet } from "@/lib/report-error";
import { KIND_LABELS, leadReason, type RadarDraft, type RadarReason, type RecommendationKind } from "@/lib/radar/types";
import { deadlineReached } from "@/lib/time-budget";
import { listActiveGoalTextsForUser } from "@/lib/user-goals";
import { loadWritingInstructions } from "@/lib/writing-instructions-store";

/** Kinds a message is the answer to. Prep is a meeting to get ready for; an opportunity, a role. */
export const RADAR_DRAFT_KINDS: readonly RecommendationKind[] = ["reach_out", "reconnect", "follow_up", "heads_up"];
export const RADAR_DRAFTS_PER_RUN = 5;
/** A draft is not started with less than this left, so the why-lines still get a turn. */
const DRAFT_MIN_REMAINING_MS = 6_000;
const DRAFT_MAX = 2_000;

/** Reasons that mean the conversation already lives on LinkedIn. */
const LINKEDIN_CODES: ReadonlySet<string> = new Set(["inbound_unanswered", "linkedin_thread_quiet"]);

type DraftTarget = {
  id: string;
  contactId: string;
  kind: RecommendationKind;
  reasons: RadarReason[];
  inputsHash: string;
  hasEmail: boolean;
};

/** Where the message should go: where the conversation is, else email, else LinkedIn. */
export function draftChannel(target: Pick<DraftTarget, "reasons" | "hasEmail">): RadarDraft["channel"] {
  if (target.reasons.some((r) => LINKEDIN_CODES.has(r.code))) return "linkedin";
  return target.hasEmail ? "email" : "linkedin";
}

/** What the draft is for, in the card's own words, so it is about the reason the card exists. */
export function draftIntent(target: Pick<DraftTarget, "kind" | "reasons">): string {
  const lead = leadReason(target.reasons);
  return lead ? `${KIND_LABELS[target.kind]}: ${lead.label}` : KIND_LABELS[target.kind];
}

async function loadDraftTargets(userId: string): Promise<DraftTarget[]> {
  const db = await getDb();
  const rows = rowsOf<{
    id: string;
    contact_id: string;
    kind: RecommendationKind;
    reasons: RadarReason[];
    inputs_hash: string;
    has_email: boolean;
  }>(
    await db.execute(sql`
      SELECT r.id, r.contact_id, r.kind, r.reasons, r.inputs_hash,
             (c.email IS NOT NULL AND btrim(c.email) <> '') AS has_email
        FROM recommendations r
        JOIN contacts c ON c.id = r.contact_id AND c.user_id = r.user_id
       WHERE r.user_id = ${userId}
         AND r.status IN ('pending', 'auto_applied')
         AND r.bucket = 'today'
         AND r.kind IN (${sql.join(RADAR_DRAFT_KINDS.map((k) => sql`${k}`), sql`, `)})
         AND (r.draft IS NULL OR r.draft ->> 'inputsHash' IS DISTINCT FROM r.inputs_hash)
       ORDER BY r.score DESC, r.id
       LIMIT ${RADAR_DRAFTS_PER_RUN}
    `)
  );
  return rows.map((r) => ({
    id: r.id,
    contactId: r.contact_id,
    kind: r.kind,
    reasons: r.reasons ?? [],
    inputsHash: r.inputs_hash,
    hasEmail: Boolean(r.has_email),
  }));
}

/**
 * Write drafts for this run's Today cards that lack a current one. Sequential, stopping
 * when the shared deadline is near. Returns how many were written. Never throws.
 */
export async function draftTodayForRun(userId: string, access: AiAccess, opts: { deadline: number }): Promise<number> {
  const targets = await loadDraftTargets(userId);
  if (targets.length === 0) return 0;
  const [goals, writingInstructions] = await Promise.all([
    listActiveGoalTextsForUser(userId, { limit: 8 }),
    loadWritingInstructions(userId),
  ]);
  const db = await getDb();
  let written = 0;
  for (const target of targets) {
    const left = opts.deadline - Date.now();
    if (deadlineReached(opts.deadline) || left < DRAFT_MIN_REMAINING_MS) break;
    const channel = draftChannel(target);
    try {
      const result = await generateContactFollowUpDraft(userId, target.contactId, goals, {
        channel,
        intent: draftIntent(target),
        reuse: true,
        writingInstructions,
        operation: "radar.draft",
        access,
        signal: AbortSignal.timeout(left),
      });
      const body = guardModelOutput((result.body ?? "").trim()).text.slice(0, DRAFT_MAX).trim();
      if (!body) continue;
      const draft: RadarDraft = { body, channel, inputsHash: target.inputsHash, generatedAt: new Date().toISOString() };
      // Only onto the card as it was when the draft was asked for, as with the AI note.
      await db
        .update(recommendations)
        .set({ draft })
        .where(
          and(
            eq(recommendations.id, target.id),
            eq(recommendations.userId, userId),
            eq(recommendations.inputsHash, target.inputsHash)
          )
        );
      written++;
    } catch (err) {
      reportUnlessQuiet(err, { where: "job.radar.draft", userId, level: "warning" });
      if (deadlineReached(opts.deadline)) break;
    }
  }
  return written;
}
