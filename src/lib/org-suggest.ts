/**
 * As-you-type suggestions for an organization name — a company, a school or any other
 * organization — for the onboarding "Dream companies & schools" field.
 *
 * Three sources, in rank order:
 *   1. Yours: the person's own `companies` rows by name prefix, so anything they typed before
 *      comes back first.
 *   2. Curated: the brand table in `brand-colors.ts`, which carries a domain for a logo.
 *   3. Wikidata: only when the first two leave the list short. Server-side only, 1.5s budget,
 *      and a failure just means the local results.
 *
 * Only the typed text leaves Orbit (to Wikidata), never anything about the person.
 */
import { brandKey, searchCuratedBrands } from "@/lib/brand-colors";
import { normalizeCompanyName } from "@/lib/company-name";
import { KIND_DESCRIPTION, NOT_AN_ORG, officialDomain, wikidataClaims, wikidataSearch } from "@/lib/wikidata";

type Fetch = typeof fetch;

export type OrgKind = "company" | "school" | "org";
export type OrgSuggestion = {
  name: string;
  domain: string | null;
  kind: OrgKind;
  source: "yours" | "curated" | "wikidata";
};

export const MAX_SUGGESTIONS = 6;
export const MAX_QUERY_CHARS = 80;
const YOURS_LIMIT = 3;
const WIKIDATA_BUDGET_MS = 1_500;
const WIKIDATA_SEARCH_LIMIT = 8;

/** A plain company, as opposed to "an organization". Narrower than `KIND_DESCRIPTION.company`. */
const COMPANY_DESCRIPTION =
  /\b(company|corporation|business|firm|enterprise|manufacturer|bank|retailer|startup|conglomerate|subsidiary|brand|multinational)\b/i;

export type SuggestOpts = {
  fetch?: Fetch;
  now?: () => number;
  /** The person's own company names starting with `normalized`. Defaults to a database read. */
  loadYours?: (userId: string, normalized: string, limit: number) => Promise<string[]>;
  /** Skip Wikidata (the person is over the rate limit). */
  localOnly?: boolean;
};

// ponytail: per-instance cache; a shared table is the upgrade if cold instances re-ask Wikidata too often.
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const CACHE_MAX = 500;
const wikiCache = new Map<string, { at: number; value: OrgSuggestion[] }>();

/** For tests. */
export function forgetOrgSuggestCache(): void {
  wikiCache.clear();
}

async function loadYoursFromDb(userId: string, normalized: string, limit: number): Promise<string[]> {
  const [{ getDb }, { companies }, { and, asc, eq, like }, { escapeLike }] = await Promise.all([
    import("@/db"),
    import("@/db/schema"),
    import("drizzle-orm"),
    import("@/lib/contact-search-rank"),
  ]);
  const db = await getDb();
  const rows = await db
    .select({ name: companies.name })
    .from(companies)
    .where(and(eq(companies.userId, userId), like(companies.nameNormalized, `${escapeLike(normalized)}%`)))
    .orderBy(asc(companies.name))
    .limit(limit);
  return rows.map((r) => r.name);
}

/** What Wikidata finds for a prefix: organizations with an official website only. */
export async function wikidataSuggestions(query: string, fetchImpl: Fetch = fetch): Promise<OrgSuggestion[] | null> {
  const started = Date.now();
  const opts = { fetch: fetchImpl, timeoutMs: WIKIDATA_BUDGET_MS };
  const hits = await wikidataSearch(query, WIKIDATA_SEARCH_LIMIT, opts);
  if (!hits) return null;
  const candidates = hits.filter((h) => (h.label || h.match?.text) && !NOT_AN_ORG.test(h.description ?? ""));
  if (!candidates.length) return [];
  const remaining = WIKIDATA_BUDGET_MS - (Date.now() - started);
  if (remaining <= 0) return null;
  const entities = await wikidataClaims(
    candidates.map((h) => h.id),
    { ...opts, timeoutMs: remaining }
  );
  if (!entities) return null;
  const out: OrgSuggestion[] = [];
  for (const hit of candidates) {
    // ponytail: "has an official website" stands in for "is an organization" (drops people and
    // places); a P31 instance-of class check is the upgrade if non-orgs slip through.
    const domain = officialDomain(entities[hit.id]?.claims);
    if (!domain) continue;
    const description = hit.description ?? "";
    const kind: OrgKind = KIND_DESCRIPTION.school.test(description)
      ? "school"
      : COMPANY_DESCRIPTION.test(description)
        ? "company"
        : "org";
    out.push({ name: (hit.label || hit.match?.text)!, domain, kind, source: "wikidata" });
  }
  return out;
}

/** Suggestions for what the person has typed so far. Never throws. */
export async function suggestOrgs(userId: string, rawQuery: string, opts: SuggestOpts = {}): Promise<OrgSuggestion[]> {
  const query = rawQuery.trim().replace(/\s+/g, " ").slice(0, MAX_QUERY_CHARS);
  const key = brandKey(query);
  if (key.length < 2) return [];
  const now = opts.now ?? Date.now;

  const found: OrgSuggestion[] = [];
  const byKey = new Map<string, OrgSuggestion>();
  const add = (s: OrgSuggestion) => {
    const k = brandKey(s.name);
    if (!k) return;
    const seen = byKey.get(k);
    if (seen) {
      // The same name from a later source: keep the first, borrow what it lacks (a logo).
      seen.domain ??= s.domain;
      if (seen.source === "yours" && s.kind !== "company") seen.kind = s.kind;
      return;
    }
    byKey.set(k, s);
    found.push(s);
  };

  try {
    const names = await (opts.loadYours ?? loadYoursFromDb)(userId, normalizeCompanyName(query), YOURS_LIMIT);
    for (const name of names) add({ name, domain: null, kind: "company", source: "yours" });
  } catch (err) {
    console.warn("[org-suggest] could not read your companies", err instanceof Error ? err.message : err);
  }

  for (const brand of searchCuratedBrands(query, MAX_SUGGESTIONS)) {
    add({ name: brand.name, domain: brand.domain ?? null, kind: brand.kind, source: "curated" });
  }

  if (!opts.localOnly && found.length < MAX_SUGGESTIONS) {
    const cached = wikiCache.get(key);
    let wiki = cached && now() - cached.at < CACHE_TTL_MS ? cached.value : null;
    if (!wiki) {
      wiki = await wikidataSuggestions(query, opts.fetch ?? fetch).catch(() => null);
      if (wiki) {
        wikiCache.delete(key);
        if (wikiCache.size >= CACHE_MAX) wikiCache.delete(wikiCache.keys().next().value!);
        wikiCache.set(key, { at: now(), value: wiki });
      }
    }
    for (const s of wiki ?? []) add({ ...s });
  }

  // Prefix matches above contains matches; the sort is stable, so source order holds within each.
  const prefix = (s: OrgSuggestion) => (brandKey(s.name).startsWith(key) ? 0 : 1);
  return found.sort((a, b) => prefix(a) - prefix(b)).slice(0, MAX_SUGGESTIONS);
}
