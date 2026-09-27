/**
 * Parsing and sanitising one listing from a third-party job feed.
 *
 * Every string here is text an anonymous pull request put into a public repository, and it
 * ends up in something a user reads. Two rules follow, and both are enforced here rather than
 * at the point of display, because "sanitise on render" is a rule somebody eventually forgets:
 *
 *   1. `sanitizeAgentText` runs at INGEST — zero-width and bidi-override characters, HTML
 *      tags, and `javascript:` / `data:` markdown links all go before storage.
 *   2. Newlines and tabs are folded to spaces. A title containing a newline opens a second
 *      visual row in the notification panel, which is the same failure `sanitizeProfileLine`
 *      guards against in the chat prompt.
 *
 * Validation is PER ENTRY, never per document. A feed of 40,000 listings will contain
 * malformed ones; throwing on the first would lose the entire ingest for one bad row, so a
 * failure is counted and skipped. A high rejection RATE is what signals schema drift.
 */
import { z } from "zod";
import { sanitizeAgentText } from "@/lib/mcp/sanitize";
import { jobCompanyKeys } from "@/lib/jobs/company-match";

export const MAX_COMPANY_NAME = 120;
export const MAX_TITLE = 200;
export const MAX_LOCATIONS = 8;
export const MAX_LOCATION = 80;

/** Above this share of rejected entries, assume the feed's shape changed. */
export const SCHEMA_DRIFT_RATIO = 0.2;

function clean(raw: string, max: number): string {
  return sanitizeAgentText(raw)
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

/**
 * An https URL, or null.
 *
 * Anything else — `http:`, `javascript:`, a relative path, junk — becomes null rather than
 * failing the entry: the posting is still real and still worth matching, it just loses its
 * link. Returning null here also means nothing downstream has to re-check a scheme.
 */
function httpsUrl(raw: unknown): string | null {
  if (typeof raw !== "string" || !raw.trim()) return null;
  try {
    const u = new URL(raw.trim());
    return u.protocol === "https:" ? u.toString() : null;
  } catch {
    return null;
  }
}

const unixSeconds = z.number().int().positive();

/**
 * Everything non-essential is optional. `sponsorship` and `degrees` appear in some forks and
 * not others; unknown keys pass through and are ignored.
 */
export const jobListingSchema = z.object({
  id: z.string().min(1),
  company_name: z.string().min(1),
  company_url: z.unknown().optional(),
  title: z.string().min(1),
  url: z.unknown().optional(),
  terms: z.array(z.string()).nullish(),
  locations: z.array(z.string()).nullish(),
  active: z.boolean().nullish(),
  is_visible: z.boolean().nullish(),
  sponsorship: z.string().nullish(),
  date_posted: unixSeconds,
  date_updated: unixSeconds.nullish(),
  source: z.string().nullish(),
});

export type RawListing = z.infer<typeof jobListingSchema>;

export type NormalisedListing = {
  externalId: string;
  companyName: string;
  companyKey: string;
  companyUrl: string | null;
  title: string;
  url: string;
  terms: string[];
  locations: string[];
  active: boolean;
  isVisible: boolean;
  sponsorship: string | null;
  datePosted: Date;
  dateUpdated: Date;
  /** Unix seconds, kept for the incremental cursor without a Date round-trip. */
  dateUpdatedUnix: number;
};

/**
 * One raw entry to a row we would store, or null when it is unusable.
 *
 * A posting with no https `url` is dropped: the link is the entire payload of the
 * notification, and "a job exists somewhere at this company" is not worth telling anyone.
 */
export function normaliseListing(raw: RawListing): NormalisedListing | null {
  const companyName = clean(raw.company_name, MAX_COMPANY_NAME);
  const title = clean(raw.title, MAX_TITLE);
  const url = httpsUrl(raw.url);
  if (!companyName || !title || !url) return null;

  const keys = jobCompanyKeys(companyName);
  if (!keys) return null;

  const dateUpdatedUnix = raw.date_updated ?? raw.date_posted;
  return {
    externalId: raw.id.trim().slice(0, 200),
    companyName,
    companyKey: keys.primary,
    companyUrl: httpsUrl(raw.company_url),
    title,
    url,
    terms: (raw.terms ?? []).map((t) => clean(t, 60)).filter(Boolean).slice(0, 8),
    locations: (raw.locations ?? [])
      .map((l) => clean(l, MAX_LOCATION))
      .filter(Boolean)
      .slice(0, MAX_LOCATIONS),
    active: raw.active ?? true,
    isVisible: raw.is_visible ?? true,
    sponsorship: raw.sponsorship ? clean(raw.sponsorship, 80) : null,
    datePosted: new Date(raw.date_posted * 1000),
    dateUpdated: new Date(dateUpdatedUnix * 1000),
    dateUpdatedUnix,
  };
}

export type ParseListingsResult = {
  entries: NormalisedListing[];
  total: number;
  rejected: number;
  /** True when the rejection rate suggests the feed's shape changed rather than a few bad rows. */
  drift: boolean;
};

/**
 * Parse a whole feed document.
 *
 * Takes `unknown` because the caller has a `JSON.parse` result, and returns counts alongside
 * the entries so the sweep can tell "a few bad rows" from "this is no longer the same file".
 */
export function parseListings(doc: unknown): ParseListingsResult {
  if (!Array.isArray(doc)) {
    return { entries: [], total: 0, rejected: 0, drift: true };
  }
  const entries: NormalisedListing[] = [];
  let rejected = 0;
  for (const item of doc) {
    const parsed = jobListingSchema.safeParse(item);
    if (!parsed.success) {
      rejected += 1;
      continue;
    }
    const normalised = normaliseListing(parsed.data);
    if (!normalised) {
      rejected += 1;
      continue;
    }
    entries.push(normalised);
  }
  const total = doc.length;
  return {
    entries,
    total,
    rejected,
    drift: total > 0 && rejected / total > SCHEMA_DRIFT_RATIO,
  };
}
