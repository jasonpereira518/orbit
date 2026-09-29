/**
 * Headlines about the companies this account's people work at.
 *
 * The hourly sweep (`src/lib/radar/feeds/sweep.ts`) files every public headline under the
 * company keys it might be about. Here, once per run, the account asks for exactly its own
 * candidates' company keys, in one indexed statement, and `companiesMatch` confirms each hit
 * before it becomes a signal. Nothing about the account ever leaves the database, and the
 * cost is O(the account's companies), not O(the news).
 *
 * At most `RADAR_NEWS_PER_RUN` a night, newest first, one per person: a busy news day must
 * not turn the list into a newsfeed. Each one is also written to `contact_signals`
 * (deduplicated), which is what "What changed overnight" and the digest read.
 */
import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import { getDb, rowsOf } from "@/db";
import { contactSignals } from "@/db/schema";
import { companiesMatch, jobCompanyBucketKey, jobCompanyKeys, type CompanyKeySet } from "@/lib/jobs/company-match";
import { RADAR_WINDOWS } from "@/lib/radar/score";
import type { RadarCandidateRow } from "@/lib/radar/signals/internal";
import type { RadarSignal } from "@/lib/radar/types";

export const RADAR_NEWS_PER_RUN = 3;
const HITS_READ = 200;
const DAY_MS = 86_400_000;

type NewsHit = {
  item_id: string;
  company_key: string;
  company_name: string;
  title: string;
  url: string | null;
  published_at: string | Date;
  source_label: string;
};

export async function probeCompanyNews(
  userId: string,
  candidates: readonly RadarCandidateRow[],
  now: Date
): Promise<Extract<RadarSignal, { kind: "company_news" }>[]> {
  const byKey = new Map<string, Array<{ contactId: string; keys: CompanyKeySet }>>();
  for (const c of candidates) {
    const keys = jobCompanyKeys(c.company);
    if (!keys) continue;
    const key = jobCompanyBucketKey(keys);
    const list = byKey.get(key);
    if (list) list.push({ contactId: c.id, keys });
    else byKey.set(key, [{ contactId: c.id, keys }]);
  }
  if (byKey.size === 0) return [];

  const db = await getDb();
  const since = new Date(now.getTime() - RADAR_WINDOWS.newsMax * DAY_MS).toISOString();
  const hits = rowsOf<NewsHit>(
    await db.execute(sql`
      SELECT c.item_id, c.company_key, c.company_name, i.title, i.url, i.published_at, s.label AS source_label
        FROM external_item_companies c
        JOIN external_items i ON i.id = c.item_id
        JOIN external_sources s ON s.id = i.source_id
       WHERE c.company_key = ANY(ARRAY[${sql.join(
         [...byKey.keys()].map((k) => sql`${k}`),
         sql`, `
       )}]::text[])
         AND c.published_at >= ${since}::timestamptz
         AND c.published_at <= ${now.toISOString()}::timestamptz
       ORDER BY c.published_at DESC, c.item_id
       LIMIT ${HITS_READ}
    `)
  );

  const signals: Extract<RadarSignal, { kind: "company_news" }>[] = [];
  const seen = new Set<string>();
  for (const hit of hits) {
    const itemKeys = jobCompanyKeys(hit.company_name);
    if (!itemKeys) continue;
    for (const person of byKey.get(hit.company_key) ?? []) {
      if (seen.has(person.contactId) || !companiesMatch(person.keys, itemKeys)) continue;
      seen.add(person.contactId);
      signals.push({
        kind: "company_news",
        contactId: person.contactId,
        at: new Date(hit.published_at),
        title: hit.title,
        source: hit.source_label,
        url: hit.url,
        itemId: hit.item_id,
        company: hit.company_name,
      });
    }
    if (signals.length >= RADAR_NEWS_PER_RUN) break;
  }
  const kept = signals.slice(0, RADAR_NEWS_PER_RUN);

  if (kept.length > 0) {
    await db
      .insert(contactSignals)
      .values(
        kept.map((s) => ({
          userId,
          contactId: s.contactId,
          kind: "company_news" as const,
          occurredAt: s.at,
          source: s.source,
          externalItemId: s.itemId,
          payload: { title: s.title, company: s.company, url: s.url, sourceLabel: s.source },
          dedupeHash: createHash("sha256").update(`company_news:${s.itemId}:${s.contactId}`).digest("hex"),
        }))
      )
      .onConflictDoNothing({ target: [contactSignals.userId, contactSignals.dedupeHash] });
  }
  return kept;
}
