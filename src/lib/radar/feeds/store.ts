/**
 * The global news tables: seeding the sources, storing headlines and the companies each may
 * be about, recording what happened to each fetch, and pruning what is too old to matter.
 * Global means no `user_id` anywhere: these rows are public headlines, shared by every
 * account and deleted with none of them (`src/lib/user-data.ts` says so beside the job feed).
 */
import { and, eq, inArray, lt, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { externalItemCompanies, externalItems, externalSources } from "@/db/schema";
import { headlineCompanies } from "@/lib/radar/feeds/companies";
import type { NewsItem } from "@/lib/radar/feeds/parse";
import { DEFAULT_NEWS_SOURCES, NEWS_MAX_AGE_DAYS, NEWS_RETENTION_DAYS } from "@/lib/radar/feeds/sources";

const DAY_MS = 86_400_000;

/**
 * Seed the configured sources. `onConflictDoNothing`, so an operator who disabled one is
 * never re-enabled by a deploy, and a fresh database needs no manual step.
 */
export async function seedNewsSources(): Promise<void> {
  const db = await getDb();
  await db
    .insert(externalSources)
    .values(DEFAULT_NEWS_SOURCES.map((s) => ({ ...s })))
    .onConflictDoNothing({ target: externalSources.id });
}

export async function listEnabledNewsSources() {
  const db = await getDb();
  return db.query.externalSources.findMany({ where: eq(externalSources.enabled, true) });
}

/**
 * Store a source's items: new headlines only (a headline seen before is left alone), each
 * with its company candidates. Returns how many were new. Items older than
 * `NEWS_MAX_AGE_DAYS` on arrival are skipped: a feed backfilling its archive is not news.
 */
export async function ingestNewsItems(sourceId: string, items: readonly NewsItem[], now: Date): Promise<number> {
  const fresh = items.filter((i) => now.getTime() - i.publishedAt.getTime() <= NEWS_MAX_AGE_DAYS * DAY_MS);
  if (fresh.length === 0) return 0;
  const db = await getDb();
  const inserted = await db
    .insert(externalItems)
    .values(
      fresh.map((i) => ({
        sourceId,
        externalId: i.externalId,
        title: i.title,
        summary: i.summary,
        url: i.url,
        publishedAt: i.publishedAt,
        firstSeenAt: now,
      }))
    )
    .onConflictDoNothing({ target: [externalItems.sourceId, externalItems.externalId] })
    .returning();
  if (inserted.length === 0) return 0;
  const companies = inserted.flatMap((row) =>
    headlineCompanies(row.title).map((c) => ({
      itemId: row.id,
      companyKey: c.key,
      companyName: c.name,
      publishedAt: row.publishedAt,
    }))
  );
  if (companies.length > 0) {
    await db
      .insert(externalItemCompanies)
      .values(companies)
      .onConflictDoNothing({ target: [externalItemCompanies.itemId, externalItemCompanies.companyKey] });
  }
  return inserted.length;
}

export type NewsOutcome = {
  status: "ok" | "not_modified" | "unreachable" | "http_error" | "too_large" | "schema_drift";
  error?: string | null;
  etag?: string | null;
  lastModified?: string | null;
  /** True for a 200 whose body was read. Only then are the validators replaced. */
  changed: boolean;
};

/** Record one fetch. `consecutive_failures` counts; any success, a 304 included, resets it. */
export async function recordNewsOutcome(sourceId: string, outcome: NewsOutcome, now: Date = new Date()): Promise<void> {
  const db = await getDb();
  const ok = outcome.status === "ok" || outcome.status === "not_modified";
  await db
    .update(externalSources)
    .set({
      lastStatus: outcome.status,
      lastError: outcome.error?.slice(0, 500) ?? null,
      lastFetchedAt: now,
      consecutiveFailures: ok ? 0 : sql`${externalSources.consecutiveFailures} + 1`,
      updatedAt: now,
      ...(outcome.changed ? { etag: outcome.etag ?? null, lastModified: outcome.lastModified ?? null } : {}),
    })
    .where(eq(externalSources.id, sourceId));
}

/** Drop headlines past `NEWS_RETENTION_DAYS`; their company rows cascade. */
export async function pruneNews(now: Date): Promise<void> {
  const db = await getDb();
  await db.delete(externalItems).where(lt(externalItems.publishedAt, new Date(now.getTime() - NEWS_RETENTION_DAYS * DAY_MS)));
}

/** Test and ops helper: remove a source's items (a smoke cleans up after itself with it). */
export async function deleteNewsForSources(sourceIds: readonly string[]): Promise<void> {
  if (sourceIds.length === 0) return;
  const db = await getDb();
  await db.delete(externalItems).where(inArray(externalItems.sourceId, [...sourceIds]));
  await db.delete(externalSources).where(and(inArray(externalSources.id, [...sourceIds])));
}
