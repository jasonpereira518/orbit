/**
 * The IO half of Radar's AI rerank (the pure half, and the reasoning, is `rerank-prompt.ts`).
 *
 * One call per run, on the account's own key, over the top `RADAR_RERANK_SIZE` picks after
 * learning. Cached by the shortlist's facts (`rerankCacheKey`), so a night where nothing
 * changed costs nothing and moves nothing. Every failure (no reply, a malformed one, a
 * timeout) leaves the scorer's order exactly as it was: the run records it and carries on.
 */
import { sql } from "drizzle-orm";
import { getDb, rowsOf } from "@/db";
import { completeJson } from "@/lib/ai";
import type { AiAccess } from "@/lib/ai-access";
import { withAiResultCache } from "@/lib/ai-result-cache";
import {
  RADAR_RERANK_SIZE,
  applyRerank,
  buildRerankPrompt,
  parseRerankReply,
  rerankCacheKey,
  type RerankAdjustment,
  type RerankCandidate,
} from "@/lib/radar/rerank-prompt";
import type { RadarPick } from "@/lib/radar/score";
import { KIND_PRIORITY } from "@/lib/radar/types";

/** How long one rerank may take before the run gives up on it and keeps the rules' order. */
export const RADAR_RERANK_TIMEOUT_MS = 8_000;
/** How long an unchanged shortlist's adjustments are reused. */
export const RADAR_RERANK_CACHE_DAYS = 7;

export type RerankProfile = { title: string | null; company: string | null; tier: "inner" | "mid" | "outer" | null };

export type RerankStatus = "ok" | "cached" | "failed" | "skipped";

export type RerankResult<T extends RadarPick> = {
  picks: Array<T & { aiDelta: number | null; aiAngle: string | null }>;
  status: RerankStatus;
  /** Cards whose score the rerank actually moved. */
  adjusted: number;
};

/** The shortlist: the best picks, in a total order so it is the same list every time. */
export function rerankShortlist<T extends RadarPick>(picks: readonly T[]): T[] {
  return [...picks]
    .sort(
      (a, b) =>
        b.score - a.score || KIND_PRIORITY[b.kind] - KIND_PRIORITY[a.kind] || a.contactId.localeCompare(b.contactId)
    )
    .slice(0, RADAR_RERANK_SIZE);
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

const unchanged = <T extends RadarPick>(picks: readonly T[], status: RerankStatus): RerankResult<T> => ({
  picks: picks.map((p) => ({ ...p, aiDelta: null, aiAngle: null })),
  status,
  adjusted: 0,
});

export async function rerankPicks<T extends RadarPick & { inputsHash: string }>(
  userId: string,
  access: AiAccess,
  picks: readonly T[],
  context: { goals: readonly string[]; profiles: ReadonlyMap<string, RerankProfile> },
  now: Date,
  opts: { timeoutMs?: number } = {}
): Promise<RerankResult<T>> {
  const shortlist = rerankShortlist(picks);
  // One card cannot be reordered against anything.
  if (shortlist.length < 2) return unchanged(picks, "skipped");

  const standings = await loadStandings(
    userId,
    shortlist.map((p) => p.contactId)
  );
  const candidates: RerankCandidate[] = shortlist.map((p) => {
    const profile = context.profiles.get(p.contactId);
    return {
      ...p,
      title: profile?.title ?? null,
      company: profile?.company ?? null,
      tier: profile?.tier ?? null,
      standing: standings.get(p.contactId) ?? null,
    };
  });
  const prompt = buildRerankPrompt(candidates, context.goals);

  let called = false;
  const entries = await withAiResultCache<Array<[string, RerankAdjustment]>>(
    userId,
    "radar.rerank",
    rerankCacheKey(candidates, context.goals),
    async () => {
      called = true;
      const raw = await completeJson(userId, {
        system: prompt.system,
        user: prompt.user,
        operation: "radar.rerank",
        maxOutputTokens: 1_500,
        access,
        signal: AbortSignal.timeout(opts.timeoutMs ?? RADAR_RERANK_TIMEOUT_MS),
      });
      const parsed = parseRerankReply(raw, prompt);
      if (!parsed || parsed.size === 0) throw new Error("radar.rerank: unusable reply");
      return [...parsed.entries()];
    },
    // Only a usable answer is replayed; an empty one must not pin the list for a week.
    { ttlDays: RADAR_RERANK_CACHE_DAYS, accept: (v) => v.length > 0 }
  );

  const applied = applyRerank(picks, new Map(entries), now);
  return {
    picks: applied,
    status: called ? "ok" : "cached",
    adjusted: applied.filter((p) => p.aiDelta !== null && p.aiDelta !== 0).length,
  };
}

export { unchanged as rerankUnchanged };
