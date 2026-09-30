/**
 * The hourly news sweep: read every enabled public feed, store what is new, prune what is
 * old. Ingest only. It never looks at an account: which headline matters to whom is decided
 * per account by the nightly run (`probeCompanyNews`), against these global rows.
 *
 * Mirrors `src/lib/jobs/feed-sweep.ts`: conditional GETs, a loud size cap, every outcome
 * recorded on its source row, and a feed being down is an ordinary outcome, never a throw.
 */
import { ERROR_SOURCES } from "@/lib/error-events";
import { EventPageError, guardedFetchText, type FetchPageDeps } from "@/lib/events/guarded-fetch";
import { parseNewsDocument } from "@/lib/radar/feeds/parse";
import { MAX_NEWS_BYTES } from "@/lib/radar/feeds/sources";
import {
  ingestNewsItems,
  listEnabledNewsSources,
  pruneNews,
  recordNewsOutcome,
  seedNewsSources,
  type NewsOutcome,
} from "@/lib/radar/feeds/store";
import type { ExternalSourceKind } from "@/lib/radar/types";

/** Stop starting new sources after this; the route's ceiling is 300 s. */
export const NEWS_SWEEP_BUDGET_MS = 120_000;
const NEWS_TIMEOUT_MS = 20_000;

const CONTENT_TYPES: Record<ExternalSourceKind, readonly string[]> = {
  hn: ["application/json", "text/plain", "text/json"],
  rss: ["application/rss+xml", "application/xml", "text/xml", "application/atom+xml", "text/plain"],
  atom: ["application/atom+xml", "application/xml", "text/xml", "application/rss+xml", "text/plain"],
  edgar: ["application/atom+xml", "application/xml", "text/xml"],
};

export type NewsSweepStats = {
  sources: number;
  fetched: number;
  notModified: number;
  failed: number;
  newItems: number;
  budgetExhausted: boolean;
};

function statusFor(error: unknown): { status: NewsOutcome["status"]; message: string } {
  if (error instanceof EventPageError) {
    if (error.code === "too_large") return { status: "too_large", message: error.message };
    if (error.code === "http_error") return { status: "http_error", message: error.message };
    if (error.code === "not_html") return { status: "schema_drift", message: error.message };
    return { status: "unreachable", message: error.message };
  }
  return { status: "unreachable", message: (error as Error)?.message ?? "Feed unreachable" };
}

export async function runNewsSweep(deps: { fetchDeps?: FetchPageDeps; now?: Date; deadline?: number } = {}): Promise<NewsSweepStats> {
  const now = deps.now ?? new Date();
  const deadline = deps.deadline ?? Date.now() + NEWS_SWEEP_BUDGET_MS;
  await seedNewsSources();
  const sources = await listEnabledNewsSources();
  const stats: NewsSweepStats = { sources: sources.length, fetched: 0, notModified: 0, failed: 0, newItems: 0, budgetExhausted: false };

  for (const source of sources) {
    if (Date.now() >= deadline) {
      stats.budgetExhausted = true;
      break;
    }
    const kind = source.kind as ExternalSourceKind;
    let res;
    try {
      res = await guardedFetchText(source.url, {
        accept: CONTENT_TYPES[kind].join(", "),
        contentTypes: CONTENT_TYPES[kind],
        wrongTypeMessage: "That feed did not return a feed document.",
        headers: {
          ...(source.etag ? { "if-none-match": source.etag } : {}),
          ...(source.lastModified ? { "if-modified-since": source.lastModified } : {}),
        },
        timeoutMs: NEWS_TIMEOUT_MS,
        maxBytes: MAX_NEWS_BYTES,
        onOverflow: "error",
        errorSource: ERROR_SOURCES.radarNewsFetch,
        deps: deps.fetchDeps,
      });
    } catch (error) {
      const { status, message } = statusFor(error);
      stats.failed += 1;
      await recordNewsOutcome(source.id, { status, error: message, changed: false }, now);
      continue;
    }
    if (res.notModified) {
      stats.notModified += 1;
      await recordNewsOutcome(source.id, { status: "not_modified", changed: false }, now);
      continue;
    }
    const items = parseNewsDocument(kind, res.text);
    if (items.length === 0) {
      // A body that arrived whole and held nothing readable is drift. Validators are not
      // stored, so the next run re-reads rather than 304ing against a document it can't use.
      stats.failed += 1;
      await recordNewsOutcome(source.id, { status: "schema_drift", error: "No items could be read", changed: false }, now);
      continue;
    }
    stats.fetched += 1;
    stats.newItems += await ingestNewsItems(source.id, items, now);
    await recordNewsOutcome(
      source.id,
      { status: "ok", changed: true, etag: res.headers.get("etag"), lastModified: res.headers.get("last-modified") },
      now
    );
  }

  await pruneNews(now);
  return stats;
}
