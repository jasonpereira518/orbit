import { and, gte, inArray, isNotNull, like, or, sql, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { usageEvents } from "@/db/schema";
import { MANAGED_MODELS } from "@/lib/managed-ai-policy";

/**
 * "About 285 captures" — what a credit balance buys, in plain language, from MEASURED cost.
 *
 * Each action is several model calls, so its cost is the sum of its operations' recorded
 * cost over the last 30 days, divided by how many times the action happened (counted by one
 * anchor operation). Orbit-key rows are preferred because that is what credits pay for; until
 * there are enough of them, rows on the managed models at anyone's key stand in (same prices,
 * same models). Below `MIN_SAMPLES` actions a figure is noise, so the equivalent is omitted
 * rather than invented. No number here is ever typed in.
 *
 * Cached per server instance for an hour: it describes a month of traffic, not this minute.
 */
export type ActionKey = "capture" | "chat" | "summary";

const ACTIONS: Record<ActionKey, { prefixes: string[]; anchor: string }> = {
  capture: { prefixes: ["capture."], anchor: "capture.parse" },
  chat: { prefixes: ["chat."], anchor: "chat.answer" },
  summary: { prefixes: ["meeting.digest", "meeting.map", "meeting.reduce"], anchor: "meeting.digest" },
};

export const MIN_SAMPLES = 20;
const WINDOW_DAYS = 30;
const TTL_MS = 60 * 60 * 1000;

let cache: { at: number; micros: Partial<Record<ActionKey, number>> } | null = null;

const MANAGED_MODEL_IDS = Object.values(MANAGED_MODELS).flat();

async function measure(action: ActionKey, orbitOnly: boolean, since: Date): Promise<number | null> {
  const { prefixes, anchor } = ACTIONS[action];
  const db = await getDb();
  const scope = orbitOnly
    ? eq(usageEvents.keyOwner, "orbit")
    : inArray(usageEvents.model, MANAGED_MODEL_IDS.length ? MANAGED_MODEL_IDS : ["-"]);
  const [row] = await db
    .select({
      cost: sql<string>`coalesce(sum(${usageEvents.estimatedCostMicros}), 0)`,
      actions: sql<number>`count(*) FILTER (WHERE ${usageEvents.operation} = ${anchor} AND ${usageEvents.success} = 1)::int`,
    })
    .from(usageEvents)
    .where(
      and(
        gte(usageEvents.createdAt, since),
        isNotNull(usageEvents.estimatedCostMicros),
        scope,
        or(...prefixes.map((p) => like(usageEvents.operation, `${p}%`)))
      )
    );
  const actions = Number(row?.actions ?? 0);
  if (actions < MIN_SAMPLES) return null;
  return Number(row?.cost ?? 0) / actions;
}

/** Average cost per action, in micros, for each action with enough measured samples. */
export async function measuredActionCosts(now = Date.now()): Promise<Partial<Record<ActionKey, number>>> {
  if (cache && now - cache.at < TTL_MS) return cache.micros;
  const since = new Date(now - WINDOW_DAYS * 86_400_000);
  const micros: Partial<Record<ActionKey, number>> = {};
  for (const action of Object.keys(ACTIONS) as ActionKey[]) {
    const value = (await measure(action, true, since)) ?? (await measure(action, false, since));
    if (value && value > 0) micros[action] = value;
  }
  cache = { at: now, micros };
  return micros;
}

/** "about 285 captures, 1,100 chat answers or 40 meeting summaries" parts, from a balance. */
export function equivalentsFor(
  spendableMicros: number,
  costs: Partial<Record<ActionKey, number>>
): Array<{ action: ActionKey; count: number }> {
  const out: Array<{ action: ActionKey; count: number }> = [];
  for (const action of ["capture", "chat", "summary"] as const) {
    const cost = costs[action];
    if (!cost) continue;
    const count = Math.floor(spendableMicros / cost);
    if (count > 0) out.push({ action, count });
  }
  return out;
}
