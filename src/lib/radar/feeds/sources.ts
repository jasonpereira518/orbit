/**
 * The public news feeds Radar reads, as data. Each one becomes an `external_sources` row
 * (seeded, never overwritten once an operator has disabled it), so adding or turning one off
 * is a row, not a deploy.
 *
 * Every request is an unauthenticated GET of a whole public feed: no query names a company,
 * a contact or an account, so a feed learns nothing about who reads it. The matching happens
 * here, against the global tables, and per account only in the nightly run.
 *
 * SEC EDGAR is deliberately absent: its fair-access policy requires a contact address in the
 * User-Agent, and `guardedFetchText` fixes its own agent string by design.
 */
import type { ExternalSourceKind } from "@/lib/radar/types";

export type NewsSourceSeed = { id: string; label: string; url: string; kind: ExternalSourceKind };

export const DEFAULT_NEWS_SOURCES: readonly NewsSourceSeed[] = [
  {
    id: "hn-stories",
    label: "Hacker News",
    url: "https://hn.algolia.com/api/v1/search_by_date?tags=story&hitsPerPage=100",
    kind: "hn",
  },
  { id: "techcrunch", label: "TechCrunch", url: "https://techcrunch.com/feed/", kind: "rss" },
  { id: "the-verge", label: "The Verge", url: "https://www.theverge.com/rss/index.xml", kind: "atom" },
  { id: "ars-technica", label: "Ars Technica", url: "https://feeds.arstechnica.com/arstechnica/index", kind: "rss" },
];

/** A feed document larger than this is not a news feed; the fetch fails loudly. */
export const MAX_NEWS_BYTES = 3 * 1024 * 1024;
/** Items kept this long, then pruned. Signals only look back `RADAR_WINDOWS.newsMax`. */
export const NEWS_RETENTION_DAYS = 14;
/** An item older than this on arrival is not news. */
export const NEWS_MAX_AGE_DAYS = 7;
/** Items read per source per sweep, newest first. */
export const NEWS_ITEMS_PER_SOURCE = 150;
/** Company candidates filed per headline. */
export const NEWS_COMPANIES_PER_ITEM = 8;
