import { sql } from "drizzle-orm";
import { getDb, rowsOf } from "@/db";
export async function voiceUsageSummary() {
  const db = await getDb();
  return rowsOf<{
    provider: string;
    starts: number;
    failed: number;
    tool_calls: number;
    connected_seconds: number;
  }>(
    await db.execute(sql`
    SELECT provider, count(*)::int AS starts, count(*) FILTER (WHERE outcome = 'failed')::int AS failed,
      coalesce(sum(tool_calls), 0)::int AS tool_calls,
      coalesce(sum(CASE WHEN connected_at IS NULL THEN 0 ELSE least(600, greatest(0,
        extract(epoch FROM least(coalesce(ended_at, now()), expires_at) - connected_at))) END), 0)::int AS connected_seconds
    FROM orbit_voice_sessions WHERE created_at > now() - interval '24 hours' GROUP BY provider
  `),
  );
}
