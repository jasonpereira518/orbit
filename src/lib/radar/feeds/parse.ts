/**
 * Turn one feed document into news items. Pure: no network, no database, so
 * `scripts/smoke-radar-feeds.ts` drives it with fixtures.
 *
 * Every string that survives is third-party text: cleaned to a single line, length-capped,
 * and every link passed through `safeHttpUrl`, before anything stores it.
 */
import { XMLParser } from "fast-xml-parser";
import { cleanSingleLine } from "@/lib/ai-security";
import { safeHttpUrl } from "@/lib/safe-links";
import { NEWS_ITEMS_PER_SOURCE } from "@/lib/radar/feeds/sources";
import type { ExternalSourceKind } from "@/lib/radar/types";

export type NewsItem = {
  externalId: string;
  title: string;
  summary: string | null;
  url: string | null;
  publishedAt: Date;
};

const xml = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  removeNSPrefix: true,
  parseTagValue: false,
  trimValues: true,
  // `&amp;` and friends decode; the fetch's `MAX_NEWS_BYTES` cap is what bounds a hostile
  // document, not this parser.
  processEntities: true,
  htmlEntities: true,
});

const asArray = <T>(v: T | T[] | undefined | null): T[] => (v === undefined || v === null ? [] : Array.isArray(v) ? v : [v]);

/** A text node, whether the parser gave a string, a number, or `{ "#text": … }`. */
function text(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  if (typeof v === "string") return v;
  if (typeof v === "number") return String(v);
  if (typeof v === "object" && v !== null && "#text" in v) return text((v as Record<string, unknown>)["#text"]);
  return null;
}

/** Strip markup from a summary: feeds put HTML in descriptions. */
function plain(v: string | null, max: number): string | null {
  if (!v) return null;
  return cleanSingleLine(v.replace(/<[^>]*>/g, " ").replace(/\s+/g, " "), max);
}

function when(v: string | null): Date | null {
  if (!v) return null;
  const d = new Date(v);
  return Number.isFinite(d.getTime()) ? d : null;
}

function item(externalId: string | null, title: string | null, url: string | null, published: Date | null, summary: string | null): NewsItem | null {
  const t = plain(title, 200);
  if (!externalId || !t || !published) return null;
  return { externalId: externalId.slice(0, 300), title: t, summary: plain(summary, 300), url: safeHttpUrl(url), publishedAt: published };
}

function parseHn(doc: string): NewsItem[] {
  let data: unknown;
  try {
    data = JSON.parse(doc);
  } catch {
    return [];
  }
  const hits = (data as { hits?: unknown[] })?.hits;
  return asArray(hits)
    .map((h) => {
      const hit = h as { objectID?: unknown; title?: unknown; url?: unknown; created_at_i?: unknown };
      const at = typeof hit.created_at_i === "number" ? new Date(hit.created_at_i * 1000) : null;
      const id = text(hit.objectID);
      // A story without its own link is a discussion; the HN page is still a real source.
      const url = text(hit.url) ?? (id ? `https://news.ycombinator.com/item?id=${id}` : null);
      return item(id ? `hn:${id}` : null, text(hit.title), url, at, null);
    })
    .filter((i): i is NewsItem => i !== null);
}

function parseXml(doc: string): NewsItem[] {
  let data: Record<string, unknown>;
  try {
    data = xml.parse(doc) as Record<string, unknown>;
  } catch {
    return [];
  }
  // RSS 2.0: rss > channel > item
  const channel = (data.rss as Record<string, unknown> | undefined)?.channel as Record<string, unknown> | undefined;
  const rssItems = asArray(channel?.item as unknown[]).map((raw) => {
    const r = raw as Record<string, unknown>;
    const link = text(r.link);
    const guid = text(r.guid) ?? link;
    return item(guid, text(r.title), link, when(text(r.pubDate) ?? text(r.date)), text(r.description));
  });
  // Atom: feed > entry
  const feed = data.feed as Record<string, unknown> | undefined;
  const atomItems = asArray(feed?.entry as unknown[]).map((raw) => {
    const e = raw as Record<string, unknown>;
    const links = asArray(e.link as unknown[]) as Array<Record<string, unknown> | string>;
    const alternate =
      links.find((l) => typeof l === "object" && (l["@_rel"] === undefined || l["@_rel"] === "alternate")) ?? links[0];
    const href = typeof alternate === "string" ? alternate : text((alternate as Record<string, unknown> | undefined)?.["@_href"]);
    return item(text(e.id) ?? href, text(e.title), href, when(text(e.published) ?? text(e.updated)), text(e.summary) ?? text(e.content));
  });
  return [...rssItems, ...atomItems].filter((i): i is NewsItem => i !== null);
}

/** Newest first, deduplicated by id, at most `NEWS_ITEMS_PER_SOURCE`. */
export function parseNewsDocument(kind: ExternalSourceKind, doc: string): NewsItem[] {
  const items = kind === "hn" ? parseHn(doc) : parseXml(doc);
  const seen = new Set<string>();
  return items
    .sort((a, b) => b.publishedAt.getTime() - a.publishedAt.getTime())
    .filter((i) => (seen.has(i.externalId) ? false : (seen.add(i.externalId), true)))
    .slice(0, NEWS_ITEMS_PER_SOURCE);
}
