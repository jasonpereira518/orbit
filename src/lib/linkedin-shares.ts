/**
 * The hashtags you use most in your own LinkedIn posts (Radar PR 11), from `Shares.csv` in the
 * LinkedIn export Orbit already keeps. Radar's weekly web search adds them to its events and
 * people-to-meet questions ("topics they post about").
 *
 * Hashtags only: no AI call, and no free-text keywords, which would be noise. Posts from the
 * last two years; a hashtag counts once you have used it at least twice; at most eight, most
 * used first. Stored as `career_profile.postTopics`, so "Remove imported details" clears it.
 */
import Papa from "papaparse";
import { and, eq, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { importFiles } from "@/db/schema";
import { setPostTopics } from "@/lib/career-profile-server";
import { gunzipExportFile } from "@/lib/linkedin-export-store";

export const POST_TOPICS_MAX = 8;
const MIN_USES = 2;
const LOOKBACK_DAYS = 730;
const DAY_MS = 86_400_000;

/**
 * LinkedIn writes a hashtag either as plain `#ClimateTech` or in its own markup,
 * `{hashtag|\#|ClimateTech}`. Both are read; a bare number (`#1`) is not a topic.
 */
const MARKUP = /\{hashtag\|\\?#\|([^}|]{2,40})\}/g;
const PLAIN = /(?:^|[^\w&])#([A-Za-z][\w]{1,39})/g;

export function shareTopics(csv: string, now: Date = new Date()): string[] {
  const parsed = Papa.parse<Record<string, string>>(csv.replace(/^﻿/, ""), { header: true, skipEmptyLines: true });
  const since = now.getTime() - LOOKBACK_DAYS * DAY_MS;
  const counts = new Map<string, { label: string; n: number }>();
  for (const row of parsed.data) {
    const text = row.ShareCommentary ?? row["Share Commentary"] ?? "";
    if (!text) continue;
    const when = Date.parse((row.Date ?? "").replace(" ", "T"));
    if (Number.isFinite(when) && when < since) continue;
    const seen = new Set<string>();
    for (const re of [MARKUP, PLAIN]) {
      for (const m of text.matchAll(re)) {
        const label = m[1].trim();
        const key = label.toLowerCase();
        if (!label || /^\d+$/.test(label) || seen.has(key)) continue;
        seen.add(key);
        const cur = counts.get(key);
        if (cur) cur.n += 1;
        else counts.set(key, { label, n: 1 });
      }
    }
  }
  return [...counts.values()]
    .filter((c) => c.n >= MIN_USES)
    .sort((a, b) => b.n - a.n || a.label.localeCompare(b.label))
    .slice(0, POST_TOPICS_MAX)
    .map((c) => c.label);
}

/**
 * Read `Shares.csv` from the export just uploaded and save its topics. An export without one,
 * or with no hashtag used twice, clears any topics an earlier export left.
 */
export async function applyShareTopics(userId: string, importId: string, now: Date = new Date()): Promise<string[]> {
  const db = await getDb();
  const [file] = await db
    .select({ gz: importFiles.gz })
    .from(importFiles)
    .where(
      and(
        eq(importFiles.userId, userId),
        eq(importFiles.importId, importId),
        sql`(lower(${importFiles.path}) = 'shares.csv' OR lower(${importFiles.path}) LIKE '%/shares.csv')`
      )
    )
    .limit(1);
  const topics = file ? shareTopics(gunzipExportFile(file.gz), now) : [];
  await setPostTopics(userId, topics);
  return topics;
}
