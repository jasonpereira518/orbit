/**
 * The optional AI line on a Radar card: one sentence of why, and one opening line.
 *
 * It is NOT the recommender. `scoreContactKinds` already chose the row, from facts, with
 * reasons a person can read, and the feature is whole without this. The model is asked to
 * say it in a sentence, which cannot reshuffle anything (the `src/lib/events/explain.ts`
 * principle, which this follows with the guards that file lacks: a fenced prompt, a schema
 * on the reply, and the output guard on anything stored).
 *
 * Runs only on the account's own key. Without one, nothing is written and the card says
 * how to add one; the deterministic reasons are the product.
 */
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { getDb, rowsOf } from "@/db";
import { recommendations } from "@/db/schema";
import { completeJson } from "@/lib/ai";
import { resolveAiAccess, type AiAccess } from "@/lib/ai-access";
import { guardModelOutput } from "@/lib/ai-security";
import { friendlyError } from "@/lib/errors";
import { chooseCompletionKey } from "@/lib/managed-ai-policy";
import { RADAR_CAPS } from "@/lib/radar/score";
import type { RadarAiNote, RadarEvidence, RadarReason, RecommendationKind } from "@/lib/radar/types";
import { buildRadarWhyPrompt, radarWhyInputs } from "@/lib/radar/why-prompt";
import { reportUnlessQuiet } from "@/lib/report-error";

const noteSchema = z.object({ why: z.string(), opener: z.string() });

const WHY_MAX = 200;
const OPENER_MAX = 300;

/** The account's AI, if it can run a completion right now; null otherwise. Never throws. */
export async function openRadarAi(userId: string): Promise<AiAccess | null> {
  try {
    const access = await resolveAiAccess(userId);
    return chooseCompletionKey(access.facts()).ok ? access : null;
  } catch {
    return null;
  }
}

type NoteTarget = {
  id: string;
  kind: RecommendationKind;
  reasons: RadarReason[];
  evidence: RadarEvidence[];
  inputsHash: string;
  contactName: string;
  title: string | null;
  company: string | null;
};

async function writeNote(
  userId: string,
  target: NoteTarget,
  access: AiAccess,
  signal?: AbortSignal,
  operation: "radar.why" | "radar.why.ask" = "radar.why"
): Promise<RadarAiNote | null> {
  const inputs = radarWhyInputs(target);
  if (inputs.facts.length === 0) return null;
  const { system, user } = buildRadarWhyPrompt(inputs);
  const raw = await completeJson(userId, {
    system,
    user,
    operation,
    maxOutputTokens: 300,
    access,
    signal,
  });
  let parsed: z.infer<typeof noteSchema>;
  try {
    const result = noteSchema.safeParse(JSON.parse(raw));
    if (!result.success) return null;
    parsed = result.data;
  } catch {
    return null;
  }
  const why = guardModelOutput(parsed.why.trim(), { system }).text.slice(0, WHY_MAX).trim();
  const opener = guardModelOutput(parsed.opener.trim(), { system }).text.slice(0, OPENER_MAX).trim();
  if (!why && !opener) return null;

  const note: RadarAiNote = { why, opener, inputsHash: target.inputsHash, generatedAt: new Date().toISOString() };
  const db = await getDb();
  // Only onto the row as it was when the note was asked for: a run that changed its facts
  // in the meantime has already cleared the note, and this one would be about old facts.
  await db
    .update(recommendations)
    .set({ aiNote: note })
    .where(
      and(
        eq(recommendations.id, target.id),
        eq(recommendations.userId, userId),
        eq(recommendations.inputsHash, target.inputsHash)
      )
    );
  return note;
}

async function loadTargets(userId: string, where: ReturnType<typeof sql>, limit: number): Promise<NoteTarget[]> {
  const db = await getDb();
  const rows = rowsOf<{
    id: string;
    kind: RecommendationKind;
    reasons: RadarReason[];
    evidence: RadarEvidence[];
    inputs_hash: string;
    full_name: string;
    preferred_name: string | null;
    title: string | null;
    company: string | null;
  }>(
    await db.execute(sql`
      SELECT r.id, r.kind, r.reasons, r.evidence, r.inputs_hash,
             c.full_name, c.preferred_name, c.title, c.company
        FROM recommendations r
        JOIN contacts c ON c.id = r.contact_id AND c.user_id = r.user_id
       WHERE r.user_id = ${userId} AND r.status = 'pending' AND ${where}
       ORDER BY r.score DESC, r.id
       LIMIT ${limit}
    `)
  );
  return rows.map((r) => ({
    id: r.id,
    kind: r.kind,
    reasons: r.reasons ?? [],
    evidence: r.evidence ?? [],
    inputsHash: r.inputs_hash,
    contactName: (r.preferred_name ?? "").trim() || r.full_name,
    title: r.title,
    company: r.company,
  }));
}

/**
 * Notes for the cards a person sees first, during a run: the top of the pending list,
 * where the stored note is missing or was written from different facts. Sequential, under
 * one deadline, so a slow provider costs the run its notes rather than its schedule.
 */
export async function explainTopForRun(
  userId: string,
  access: AiAccess,
  opts: { budgetMs: number }
): Promise<number> {
  const signal = AbortSignal.timeout(Math.max(1_000, opts.budgetMs));
  const top = await loadTargets(userId, sql`TRUE`, RADAR_CAPS.today);
  const db = await getDb();
  const current = rowsOf<{ id: string }>(
    await db.execute(sql`
      SELECT id FROM recommendations
       WHERE user_id = ${userId} AND status = 'pending'
         AND ai_note IS NOT NULL AND ai_note ->> 'inputsHash' = inputs_hash
    `)
  );
  const fresh = new Set(current.map((r) => r.id));
  let written = 0;
  for (const target of top) {
    if (fresh.has(target.id)) continue;
    if (signal.aborted) break;
    try {
      if (await writeNote(userId, target, access, signal)) written++;
    } catch (err) {
      reportUnlessQuiet(err, { where: "job.radar.why", userId, level: "warning" });
      if (signal.aborted) break;
    }
  }
  return written;
}

/** One card's note on demand, from the page. */
export async function explainRecommendation(
  userId: string,
  recommendationId: string
): Promise<{ ok: true; note: RadarAiNote } | { ok: false; reason: "no_key" | "no_facts" | "not_found" | "ai_error"; message?: string }> {
  const [target] = await loadTargets(userId, sql`r.id = ${recommendationId}`, 1);
  if (!target) return { ok: false, reason: "not_found" };
  const access = await openRadarAi(userId);
  if (!access) return { ok: false, reason: "no_key" };
  try {
    const note = await writeNote(userId, target, access, AbortSignal.timeout(20_000), "radar.why.ask");
    return note ? { ok: true, note } : { ok: false, reason: "no_facts" };
  } catch (err) {
    return { ok: false, reason: "ai_error", message: friendlyError(err, "Couldn’t write that just now — try again?") };
  }
}
