/**
 * The IO half of Radar's editor (the pure half, and the reasoning, is `editor-prompt.ts`).
 *
 * One call per weekly build, on the account's key, over the top `RADAR_EDITOR_SIZE` verified
 * picks after learning. It orders them (bounded nudges) and writes each one's "why" and opener
 * in the same answer. Cached by the shortlist's facts (`editorCacheKey`), so a week where
 * nothing changed costs nothing and moves nothing. Every failure (no reply, a malformed one, a
 * timeout) leaves the scorer's order and reasons exactly as they were: the run records it and
 * carries on, and a card's "why" can still be asked for on demand (`explain.ts`).
 */
import { sql } from "drizzle-orm";
import { getDb, rowsOf } from "@/db";
import { completeJson } from "@/lib/ai";
import type { AiAccess } from "@/lib/ai-access";
import { withAiResultCache } from "@/lib/ai-result-cache";
import {
  RADAR_EDITOR_SIZE,
  applyEditor,
  buildEditorPrompt,
  editorCacheKey,
  parseEditorReply,
  type EditedPick,
  type EditorCandidate,
  type EditorItem,
} from "@/lib/radar/editor-prompt";
import type { RadarPick } from "@/lib/radar/score";
import { KIND_PRIORITY } from "@/lib/radar/types";

/** How long one edit may take before the run gives up on it and keeps the rules' order. */
export const RADAR_EDITOR_TIMEOUT_MS = 12_000;
/** How long an unchanged shortlist's answer is reused. */
export const RADAR_EDITOR_CACHE_DAYS = 7;

export type EditorProfile = { title: string | null; company: string | null; tier: "inner" | "mid" | "outer" | null };

export type EditorStatus = "ok" | "cached" | "failed" | "skipped";

export type EditorResult<T extends RadarPick> = {
  picks: Array<EditedPick<T>>;
  status: EditorStatus;
  /** Cards whose score the editor actually moved. */
  adjusted: number;
  /** Cards that came back with a "why" or an opener. */
  noted: number;
};

/** The shortlist: the best picks, in a total order so it is the same list every time. */
export function editorShortlist<T extends RadarPick>(picks: readonly T[]): T[] {
  return [...picks]
    .sort(
      (a, b) =>
        b.score - a.score || KIND_PRIORITY[b.kind] - KIND_PRIORITY[a.kind] || a.contactId.localeCompare(b.contactId)
    )
    .slice(0, RADAR_EDITOR_SIZE);
}

async function loadStandings(userId: string, contactIds: readonly string[]): Promise<Map<string, string>> {
  if (contactIds.length === 0) return new Map();
  const db = await getDb();
  const rows = rowsOf<{ contact_id: string; standing: string | null }>(
    await db.execute(sql`
      SELECT contact_id, standing FROM contact_briefs
       WHERE user_id = ${userId}
         AND contact_id = ANY(ARRAY[${sql.join(
           contactIds.map((id) => sql`${id}`),
           sql`, `
         )}]::uuid[])
    `)
  );
  return new Map(rows.filter((r) => r.standing).map((r) => [r.contact_id, r.standing!]));
}

export const editorUnchanged = <T extends RadarPick>(picks: readonly T[], status: EditorStatus): EditorResult<T> => ({
  picks: picks.map((p) => ({ ...p, aiDelta: null, aiAngle: null, aiNote: null })),
  status,
  adjusted: 0,
  noted: 0,
});

export async function editPicks<T extends RadarPick & { inputsHash: string }>(
  userId: string,
  access: AiAccess,
  picks: readonly T[],
  context: { goals: readonly string[]; profiles: ReadonlyMap<string, EditorProfile> },
  now: Date,
  opts: { timeoutMs?: number } = {}
): Promise<EditorResult<T>> {
  const shortlist = editorShortlist(picks);
  if (shortlist.length === 0) return editorUnchanged(picks, "skipped");

  const standings = await loadStandings(
    userId,
    shortlist.map((p) => p.contactId)
  );
  const candidates: EditorCandidate[] = shortlist.map((p) => {
    const profile = context.profiles.get(p.contactId);
    return {
      ...p,
      title: profile?.title ?? null,
      company: profile?.company ?? null,
      tier: profile?.tier ?? null,
      standing: standings.get(p.contactId) ?? null,
    };
  });
  const prompt = buildEditorPrompt(candidates, context.goals);

  let called = false;
  const entries = await withAiResultCache<Array<[string, EditorItem]>>(
    userId,
    // The operation id stays "radar.rerank": its pricing, credits and allowlists already count
    // it, and the editor is the same one call a week the rerank was.
    "radar.rerank",
    editorCacheKey(candidates, context.goals),
    async () => {
      called = true;
      const raw = await completeJson(userId, {
        system: prompt.system,
        user: prompt.user,
        operation: "radar.rerank",
        maxOutputTokens: 3_000,
        access,
        signal: AbortSignal.timeout(opts.timeoutMs ?? RADAR_EDITOR_TIMEOUT_MS),
      });
      const parsed = parseEditorReply(raw, prompt);
      if (!parsed || parsed.size === 0) throw new Error("radar.editor: unusable reply");
      return [...parsed.entries()];
    },
    // Only a usable answer is replayed; an empty one must not pin the list for a week.
    { ttlDays: RADAR_EDITOR_CACHE_DAYS, accept: (v) => v.length > 0 }
  );

  const applied = applyEditor(picks, new Map(entries), now);
  return {
    picks: applied,
    status: called ? "ok" : "cached",
    adjusted: applied.filter((p) => p.aiDelta !== null && p.aiDelta !== 0).length,
    noted: applied.filter((p) => p.aiNote !== null).length,
  };
}
