/**
 * The small slice of Wikidata's API Orbit reads, shared by brand-color learning
 * (`org-brand-learn.ts`) and organization suggestions (`org-suggest.ts`). Server-only by use,
 * but pure: no database. Every call sends a descriptive User-Agent (Wikimedia's API policy),
 * times out, and returns null instead of throwing.
 */
import type { BrandKind } from "@/lib/brand-colors";

type Fetch = typeof fetch;

const API = "https://www.wikidata.org/w/api.php";
const USER_AGENT = "OrbitBot/1.0 (+https://orbit.app; organization lookups)";
const DEFAULT_TIMEOUT_MS = 5_000;

const DOMAIN_RE = /^(?=.{3,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

/** Exactly a bare lowercase hostname with a dot: no scheme, port, path or credentials. */
export function isBareDomain(value: string): boolean {
  return DOMAIN_RE.test(value);
}

/** A bare, lowercase registrable-looking host from a URL, a host or an email, or null. */
export function toDomain(value: string | null | undefined): string | null {
  if (!value) return null;
  let host = value.trim().toLowerCase();
  if (host.includes("@")) host = host.slice(host.lastIndexOf("@") + 1);
  else {
    try {
      host = new URL(/^[a-z]+:\/\//.test(host) ? host : `https://${host}`).hostname;
    } catch {
      return null;
    }
  }
  host = host.replace(/^www\./, "").replace(/\.$/, "");
  return DOMAIN_RE.test(host) ? host : null;
}

export type WikidataOpts = { fetch?: Fetch; timeoutMs?: number; userAgent?: string };

export async function getJson(url: string, opts: WikidataOpts = {}): Promise<unknown | null> {
  try {
    const res = await (opts.fetch ?? fetch)(url, {
      headers: { "user-agent": opts.userAgent ?? USER_AGENT, accept: "application/json" },
      signal: AbortSignal.timeout(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    });
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
}

/** Descriptions that are plainly the right kind of organization. */
export const KIND_DESCRIPTION: Record<BrandKind, RegExp> = {
  school: /\b(university|college|school|institute|academy|polytechnic|conservatory|seminary)\b/i,
  company:
    /\b(company|corporation|business|firm|enterprise|manufacturer|maker|producer|contractor|bank|retailer|chain|restaurant|airline|startup|developer|provider|brand|conglomerate|group|agency|organi[sz]ation|platform|service|publisher|studio|consultancy|fund|operator|laborator(y|ies)|nonprofit|foundation|software|technology)\b/i,
};

/** Descriptions that are plainly not an organization at all. */
export const NOT_AN_ORG =
  /\b(family name|given name|surname|human|person|actor|actress|singer|musician|politician|athlete|player|film|album|song|single|episode|novel|book|painting|character|species|genus|village|town|city|municipality|river|mountain|lake|island|disambiguation|wikimedia|scholarly article|video game)\b/i;

export type Claims = Record<string, Array<{ mainsnak?: { datavalue?: { value?: unknown } } }>>;

export function claimValues(claims: Claims | undefined, property: string): unknown[] {
  return (claims?.[property] ?? [])
    .map((c) => c.mainsnak?.datavalue?.value)
    .filter((v) => v !== undefined);
}

export type WikidataSearchHit = { id: string; label?: string; description?: string; match?: { text?: string } };

/** `wbsearchentities`: label and alias prefix search over items. */
export async function wikidataSearch(
  query: string,
  limit: number,
  opts: WikidataOpts = {}
): Promise<WikidataSearchHit[] | null> {
  const res = (await getJson(
    `${API}?action=wbsearchentities&format=json&language=en&uselang=en&type=item&limit=${limit}&search=${encodeURIComponent(query)}`,
    opts
  )) as { search?: WikidataSearchHit[] } | null;
  return res ? (res.search ?? []) : null;
}

/** `wbgetentities` claims for up to 50 ids in one call. */
export async function wikidataClaims(
  ids: readonly string[],
  opts: WikidataOpts = {}
): Promise<Record<string, { claims?: Claims }> | null> {
  if (!ids.length) return {};
  const res = (await getJson(
    `${API}?action=wbgetentities&format=json&props=claims&ids=${ids.slice(0, 50).join("|")}`,
    opts
  )) as { entities?: Record<string, { claims?: Claims }> } | null;
  return res ? (res.entities ?? {}) : null;
}

/** The official website (P856) of an item, as a bare domain. */
export function officialDomain(claims: Claims | undefined): string | null {
  const website = claimValues(claims, "P856").find((v): v is string => typeof v === "string");
  return toDomain(website);
}
