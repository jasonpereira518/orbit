import { eq } from "drizzle-orm";
import { PLAN_CONFIG, type Plan } from "@/lib/plans/plan-config";
import { consumePlanMeter, meterResetsAt } from "@/lib/plan-meters";
import { recordGateHitThrottled } from "@/lib/gate-events";
import { ERROR_SOURCES, recordErrorEvent } from "@/lib/error-events";
import { getDb } from "@/db";
import { userSettings } from "@/db/schema";
import { decryptOrNull } from "@/lib/crypto";
import { UserFacingError } from "@/lib/errors";
import { RATE_LIMITS, consumeBucket, isRateLimitedError } from "@/lib/rate-limit";
import { normalizeCompanyKey } from "@/lib/company-name";
import {
  LINKEDIN_REFRESH_BATCH_SIZE,
  type AudienceFilters,
  type NormalizedProspect,
  type OutreachSearchSource,
} from "@/lib/outreach-types";
import { entitlementsFromSettings, getEntitlements } from "@/lib/entitlements";

const APOLLO_SEARCH_URL = "https://api.apollo.io/api/v1/mixed_people/search";
const APOLLO_MATCH_URL = "https://api.apollo.io/api/v1/people/match";
const APOLLO_TIMEOUT_MS = 10_000;
const APOLLO_MAX_ATTEMPTS = 3;
const APOLLO_BATCH_CONCURRENCY = 3;

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function jitteredBackoffMs(attempt: number) {
  return 300 * 2 ** attempt + Math.floor(Math.random() * 250);
}

async function apolloFetch(
  url: string,
  apiKey: string,
  body: Record<string, unknown>
): Promise<Response> {
  let lastResponse: Response | null = null;
  for (let attempt = 0; attempt < APOLLO_MAX_ATTEMPTS; attempt++) {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "no-cache",
        "X-Api-Key": apiKey,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(APOLLO_TIMEOUT_MS),
    });
    lastResponse = response;
    const retryable = response.status === 429 || response.status >= 500;
    if (!retryable || attempt === APOLLO_MAX_ATTEMPTS - 1) {
      // Only when retries were actually exhausted — a first-attempt 4xx is the caller's
      // problem and is already surfaced to them.
      if (retryable && attempt === APOLLO_MAX_ATTEMPTS - 1) {
        await recordErrorEvent({
          source: ERROR_SOURCES.apolloSearch,
          kind: "retry_exhausted",
          message: `Apollo returned ${response.status} after ${APOLLO_MAX_ATTEMPTS} attempts`,
          context: { status: response.status, attempts: APOLLO_MAX_ATTEMPTS },
        });
      }
      return response;
    }
    const retryAfter = Number(response.headers.get("retry-after"));
    const waitMs =
      Number.isFinite(retryAfter) && retryAfter > 0
        ? Math.min(retryAfter * 1000, 8_000)
        : jitteredBackoffMs(attempt);
    await sleep(waitMs);
  }
  return lastResponse!;
}

type ApolloEmployment = {
  organization_name?: string | null;
  title?: string | null;
  degree?: string | null;
  kind?: string | null;
  major?: string | null;
  current?: boolean | null;
  end_date?: string | null;
  start_date?: string | null;
};

type ApolloEducation = {
  school_name?: string | null;
  organization_name?: string | null;
  name?: string | null;
};

type ApolloPerson = {
  id?: string;
  first_name?: string;
  last_name?: string;
  name?: string;
  title?: string;
  email?: string;
  phone_numbers?: Array<{ raw_number?: string; sanitized_number?: string }>;
  linkedin_url?: string;
  photo_url?: string | null;
  city?: string;
  state?: string;
  country?: string;
  organization?: { name?: string };
  employment_history?: ApolloEmployment[];
  education?: ApolloEducation[];
};

export type LinkedInProfileEnrichment = {
  firstName: string | null;
  lastName: string | null;
  title: string | null;
  company: string | null;
  email: string | null;
  location: string | null;
  school: string | null;
  profileImageUrl: string | null;
  linkedinUrl: string | null;
};

/** Shown once a user has spent the day's share of Orbit's hosted Apollo key. */
export const APOLLO_DAILY_LIMIT_MESSAGE =
  "You’ve used today’s Apollo lookups on Orbit’s key — add your own Apollo key in Settings, or try again tomorrow";

/** Shown when a plan's monthly enrichments on Orbit's Apollo key are used. */
export function apolloMonthlyLimitMessage(plan: Plan, limit: number): string {
  const resets = meterResetsAt().toLocaleDateString("en-US", { month: "long", day: "numeric", timeZone: "UTC" });
  const upgrade = plan === "orbit" ? ", move to Max for 25 a month," : "";
  return `You’ve used this month’s ${limit} contact enrichments on Orbit’s key — add your own Apollo key in Settings${upgrade} or wait until ${resets}`;
}

/** A caller's already-loaded `user_settings` row, so the key check need not re-read it. */
type LoadedSettingsRow = typeof userSettings.$inferSelect;

async function resolveApolloKey(
  userId: string,
  // Optional: a caller already holding the account's row (e.g. `getSettings`) passes it and
  // skips the re-read. Omitted, this reads the row exactly as before.
  loadedSettings?: LoadedSettingsRow
): Promise<{ apiKey: string; hosted: boolean } | null> {
  const settings =
    loadedSettings ??
    (await (await getDb()).query.userSettings.findFirst({
      where: eq(userSettings.userId, userId),
    }));
  const personal = decryptOrNull(settings?.apolloApiKeyEncrypted);
  if (personal) return { apiKey: personal, hosted: false };

  // Orbit's shared Apollo key: Pro, Max and Lifetime, capped per month by plan
  // (`spendHostedApollo`). Free adds its own key in Settings, which the short-circuit above
  // already prefers on every plan.
  const { canUseHostedEnrichment } = loadedSettings
    ? entitlementsFromSettings(userId, loadedSettings)
    : await getEntitlements(userId);
  if (!canUseHostedEnrichment) return null;
  const hosted = process.env.APOLLO_API_KEY || null;
  return hosted ? { apiKey: hosted, hosted: true } : null;
}

export async function getApolloApiKey(
  userId: string,
  loadedSettings?: LoadedSettingsRow
): Promise<string | null> {
  return (await resolveApolloKey(userId, loadedSettings))?.apiKey ?? null;
}

/**
 * Counts `units` hosted calls. A user's own key never gets here.
 *
 * Enrichments are capped per MONTH by plan (`PLAN_CONFIG[plan].hostedEnrichmentsPerMonth`:
 * Pro 10, Max and Lifetime 25) — the number the pricing page promises. Searches only run in
 * the unshipped Outreach and Leads surfaces and keep just the daily abuse ceiling, which
 * also stays under enrichments.
 */
async function spendHostedApollo(userId: string, kind: "search" | "enrich", units = 1): Promise<void> {
  if (kind === "enrich") {
    const { plan } = await getEntitlements(userId);
    const limit = PLAN_CONFIG[plan].hostedEnrichmentsPerMonth;
    if (!(await consumePlanMeter(userId, "hosted_enrichment", units, limit))) {
      await recordGateHitThrottled({ userId, feature: "hostedEnrichment", plan, context: { monthly: limit } });
      throw new UserFacingError(apolloMonthlyLimitMessage(plan, limit));
    }
  }
  const policy = kind === "search" ? RATE_LIMITS.apolloSearch : RATE_LIMITS.apolloEnrich;
  try {
    for (let i = 0; i < units; i++) {
      await consumeBucket(`apollo.${kind}`, userId, policy);
    }
  } catch (err) {
    if (isRateLimitedError(err)) throw new UserFacingError(APOLLO_DAILY_LIMIT_MESSAGE);
    throw err;
  }
}

export async function userHasApolloKey(
  userId: string,
  loadedSettings?: LoadedSettingsRow
): Promise<boolean> {
  return Boolean(await getApolloApiKey(userId, loadedSettings));
}

function personLocation(person: ApolloPerson) {
  return [person.city, person.state, person.country].filter(Boolean).join(", ");
}

function extractSchool(person: ApolloPerson): string | null {
  const education = person.education ?? [];
  for (const entry of education) {
    const name =
      entry.school_name?.trim() ||
      entry.organization_name?.trim() ||
      entry.name?.trim();
    if (name) return name;
  }

  const history = person.employment_history ?? [];
  const eduJobs = history.filter(
    (job) =>
      Boolean(job.degree?.trim()) ||
      Boolean(job.major?.trim()) ||
      job.kind?.toLowerCase() === "education"
  );
  eduJobs.sort((a, b) => {
    const aStart = a.start_date || "";
    const bStart = b.start_date || "";
    return bStart.localeCompare(aStart);
  });
  for (const job of eduJobs) {
    const name = job.organization_name?.trim();
    if (name) return name;
  }

  return null;
}

function normalizeLinkedInProfile(
  person: ApolloPerson
): LinkedInProfileEnrichment {
  const photo = person.photo_url?.trim() || null;
  const firstName = person.first_name?.trim() || null;
  const lastName = person.last_name?.trim() || null;

  return {
    firstName,
    lastName,
    title: person.title?.trim() || null,
    company: person.organization?.name?.trim() || null,
    email: person.email?.trim() || null,
    location: personLocation(person) || null,
    school: extractSchool(person),
    profileImageUrl: photo,
    linkedinUrl: person.linkedin_url?.trim() || null,
  };
}

function normalizePerson(person: ApolloPerson): NormalizedProspect | null {
  const fullName =
    person.name?.trim() ||
    [person.first_name, person.last_name].filter(Boolean).join(" ").trim();
  if (!fullName) return null;

  const phone =
    person.phone_numbers?.find((p) => p.sanitized_number || p.raw_number)
      ?.sanitized_number ||
    person.phone_numbers?.find((p) => p.raw_number)?.raw_number ||
    null;

  return {
    externalId: person.id || `apollo-${fullName.toLowerCase().replace(/\s+/g, "-")}`,
    fullName,
    title: person.title?.trim() || null,
    company: person.organization?.name?.trim() || null,
    email: person.email?.trim() || null,
    phone: phone?.trim() || null,
    linkedinUrl: person.linkedin_url?.trim() || null,
    location: personLocation(person) || null,
    enrichment: person as Record<string, unknown>,
  };
}

export { normalizeCompanyKey };

export function companyMatchesOrganizations(
  company: string | null | undefined,
  organizationNames: string[] | undefined
) {
  if (!organizationNames?.length) return true;
  if (!company?.trim()) return false;
  const companyKey = normalizeCompanyKey(company);
  return organizationNames.some((org) => {
    const orgKey = normalizeCompanyKey(org);
    if (!orgKey) return false;
    return companyKey.includes(orgKey) || orgKey.includes(companyKey);
  });
}

function mockCompanyName(filters: AudienceFilters, index: number) {
  const org = filters.organizationNames?.[0]?.trim();
  if (org) return org;
  const fromKeywords = filters.keywords?.trim();
  if (fromKeywords) {
    // Use a meaningful phrase, not the first token + "Labs"
    const cleaned = fromKeywords
      // `at`, `in` and `with` matter as much as the rest: "recruiters at Stripe"
      // otherwise produced prospects working at a company called "at Stripe", with
      // addresses @atstripe.example.com.
      .replace(/\b(recruiters?|for|or|and|the|a|an|at|in|with|from)\b/gi, " ")
      .replace(/\s+/g, " ")
      .trim();
    if (cleaned.length >= 3) return cleaned.split(" ").slice(0, 4).join(" ");
  }
  return `Demo Company ${index}`;
}

function mockProspects(filters: AudienceFilters, page: number): NormalizedProspect[] {
  const keyword = filters.keywords || filters.titles?.[0] || "recruiter";
  const location = filters.locations?.[0] || "United States";
  const title =
    filters.titles?.[0] ||
    (keyword.toLowerCase().includes("recruiter") ? "Recruiter" : "Professional");
  const base = (page - 1) * 10;

  return Array.from({ length: 10 }, (_, i) => {
    const n = base + i + 1;
    const first = [
      "Alex",
      "Jordan",
      "Taylor",
      "Morgan",
      "Casey",
      "Riley",
      "Sam",
      "Avery",
      "Quinn",
      "Blake",
    ][i];
    const last = [
      "Chen",
      "Patel",
      "Nguyen",
      "Brooks",
      "Kim",
      "Rivera",
      "Shah",
      "Davis",
      "Lee",
      "Martinez",
    ][i];
    const company = mockCompanyName(filters, n);
    const slug = `${first.toLowerCase()}-${last.toLowerCase()}-${n}`;
    return {
      externalId: `demo-${normalizeCompanyKey(company).replace(/\s+/g, "-")}-${n}`,
      fullName: `${first} ${last}`,
      title,
      company,
      // `.invalid` is reserved by RFC 6761 and can never resolve. A fixed reserved domain
      // rather than one derived from the company or the audience filters: nothing Orbit
      // invents may carry an address that could route, and a domain built from the user's
      // own search terms is one edit away from being one.
      email: `${first.toLowerCase()}.${last.toLowerCase()}@demo.orbit.invalid`,
      // The reserved 555 range, kept: it is the phone equivalent of `.invalid`.
      phone: n % 3 === 0 ? `+1415555${String(1000 + n).slice(-4)}` : null,
      linkedinUrl: `https://www.linkedin.com/in/${slug}`,
      location,
      enrichment: {
        demo: true,
        keyword,
        page,
        organizationNames: filters.organizationNames ?? [],
      },
    };
  });
}

function buildSearchBody(filters: AudienceFilters, page: number) {
  const body: Record<string, unknown> = {
    page,
    per_page: 25,
  };

  if (filters.titles?.length) {
    body.person_titles = filters.titles;
  }
  if (filters.locations?.length) {
    body.person_locations = filters.locations;
  }
  if (filters.industries?.length) {
    body.organization_industry_tag_ids = filters.industries;
  }
  if (filters.seniorities?.length) {
    body.person_seniorities = filters.seniorities;
  }

  const domains = (filters.organizationDomains ?? [])
    .map((d) => d.trim().replace(/^www\./, ""))
    .filter(Boolean);
  if (domains.length) {
    body.q_organization_domains_list = domains;
  }

  const orgNames = (filters.organizationNames ?? []).map((n) => n.trim()).filter(Boolean);
  const keywordParts = [filters.keywords?.trim(), ...orgNames].filter(Boolean);
  if (keywordParts.length) {
    // Include org names in keywords when domain list is empty so Apollo still biases toward the company
    body.q_keywords = Array.from(new Set(keywordParts)).join(" ");
  }

  return body;
}

export async function searchPeople(
  userId: string,
  filters: AudienceFilters,
  page = 1
): Promise<{
  prospects: NormalizedProspect[];
  total: number;
  source: OutreachSearchSource;
}> {
  const key = await resolveApolloKey(userId);

  if (!key) {
    return {
      prospects: mockProspects(filters, page),
      total: 50,
      source: "demo",
    };
  }

  if (key.hosted) await spendHostedApollo(userId, "search");

  const response = await apolloFetch(
    APOLLO_SEARCH_URL,
    key.apiKey,
    buildSearchBody(filters, page)
  );

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Apollo search failed (${response.status}): ${text.slice(0, 200)}`);
  }

  const data = (await response.json()) as {
    people?: ApolloPerson[];
    pagination?: { total_entries?: number };
  };

  const prospects = (data.people ?? [])
    .map(normalizePerson)
    .filter((p): p is NormalizedProspect => Boolean(p));

  return {
    prospects,
    total: data.pagination?.total_entries ?? prospects.length,
    source: "apollo",
  };
}

/**
 * Look up a LinkedIn headshot via Apollo's people/match, for the avatar backfill's
 * last-resort source (paid, so it only runs for contacts a free lookup already
 * couldn't photo). Returns null on any failure or no-key/no-match — never throws,
 * so one contact's Apollo miss doesn't stop the rest of a backfill batch.
 */
export async function fetchApolloLinkedInPhoto(
  userId: string,
  linkedinUrl: string
): Promise<string | null> {
  const apiKey = await getApolloApiKey(userId);
  if (!apiKey) return null;

  try {
    const response = await apolloFetch(APOLLO_MATCH_URL, apiKey, {
      linkedin_url: linkedinUrl,
    });
    if (!response.ok) return null;
    const data = (await response.json()) as { person?: ApolloPerson | null };
    return data.person?.photo_url?.trim() || null;
  } catch {
    return null;
  }
}

export async function enrichPerson(
  userId: string,
  externalId: string,
  hints?: { email?: string; linkedinUrl?: string; fullName?: string }
): Promise<NormalizedProspect | null> {
  const key = await resolveApolloKey(userId);
  if (!key || externalId.startsWith("demo-")) {
    return null;
  }
  if (key.hosted) await spendHostedApollo(userId, "enrich");

  const body: Record<string, unknown> = {};
  if (hints?.email) body.email = hints.email;
  if (hints?.linkedinUrl) body.linkedin_url = hints.linkedinUrl;
  if (hints?.fullName) body.name = hints.fullName;

  const response = await apolloFetch(APOLLO_MATCH_URL, key.apiKey, body);

  if (!response.ok) return null;

  const data = (await response.json()) as { person?: ApolloPerson };
  if (!data.person) return null;
  return normalizePerson(data.person);
}

/**
 * Enrich people by LinkedIn URL via Apollo people/match (one request each).
 * Free Apollo plans do not include bulk_match — single match works with credits.
 * Returns one result per input, in order — null when no match.
 */
export async function enrichPeopleFromLinkedIn(
  userId: string,
  people: Array<{
    linkedinUrl: string;
    fullName?: string | null;
    email?: string | null;
  }>
): Promise<(LinkedInProfileEnrichment | null)[]> {
  if (people.length === 0) return [];
  if (people.length > LINKEDIN_REFRESH_BATCH_SIZE) {
    throw new Error(
      `Refresh at most ${LINKEDIN_REFRESH_BATCH_SIZE} contacts at a time`
    );
  }

  const key = await resolveApolloKey(userId);
  if (!key) {
    throw new Error(
      "Add an Apollo API key in Settings → Outreach to refresh LinkedIn profiles."
    );
  }
  if (key.hosted) await spendHostedApollo(userId, "enrich", people.length);
  // Rebind post-guard so the hoisted matchOne closure sees `string`, not
  // `string | null`.
  const apiKey = key.apiKey;

  const results: (LinkedInProfileEnrichment | null)[] = new Array(people.length);
  let nextIndex = 0;
  let firstError: Error | null = null;

  async function matchOne(person: (typeof people)[number]) {
    const body: Record<string, string> = {
      linkedin_url: person.linkedinUrl,
    };
    if (person.fullName?.trim()) body.name = person.fullName.trim();
    if (person.email?.trim()) body.email = person.email.trim();

    const response = await apolloFetch(APOLLO_MATCH_URL, apiKey, body);

    if (!response.ok) {
      const text = await response.text();
      if (response.status === 403) {
        throw new Error(
          "Apollo people enrichment is not available on your current plan. Upgrade at apollo.io or use a paid API key."
        );
      }
      throw new Error(
        `LinkedIn refresh failed (${response.status}): ${text.slice(0, 200)}`
      );
    }

    const data = (await response.json()) as { person?: ApolloPerson | null };
    return data.person ? normalizeLinkedInProfile(data.person) : null;
  }

  async function worker() {
    while (nextIndex < people.length) {
      const current = nextIndex++;
      if (firstError) return;
      try {
        results[current] = await matchOne(people[current]);
      } catch (err) {
        firstError = err instanceof Error ? err : new Error(String(err));
      }
    }
  }

  await Promise.all(
    Array.from(
      { length: Math.min(APOLLO_BATCH_CONCURRENCY, people.length) },
      () => worker()
    )
  );
  if (firstError) throw firstError;
  return results;
}

function guessDomainFromOrgName(name: string): string | null {
  const key = normalizeCompanyKey(name);
  const known: Record<string, string> = {
    "capital one": "capitalone.com",
    google: "google.com",
    meta: "meta.com",
    facebook: "meta.com",
    amazon: "amazon.com",
    microsoft: "microsoft.com",
    apple: "apple.com",
    netflix: "netflix.com",
    stripe: "stripe.com",
    airbnb: "airbnb.com",
  };
  if (known[key]) return known[key];
  const compact = key.replace(/\s+/g, "");
  if (compact.length >= 3) return `${compact}.com`;
  return null;
}

export async function parseAudienceToFilters(
  userId: string,
  audienceQuery: string
): Promise<AudienceFilters> {
  const { completeJson } = await import("@/lib/ai");
  const content = await completeJson(userId, {
    operation: "outreach.apollo",
    temperature: 0.1,
    system: `Extract structured Apollo people-search filters from a natural language audience description.
Return JSON:
{
  "titles": string[],
  "locations": string[],
  "industries": string[],
  "keywords": string,
  "seniorities": string[],
  "organizationNames": string[],
  "organizationDomains": string[]
}
Rules:
- organizationNames: employer companies explicitly named (e.g. "Capital One" from "Capital One recruiters").
- organizationDomains: known/likely corporate domains without www (e.g. capitalone.com). Guess when obvious.
- titles: job titles to search (e.g. Recruiter, University Recruiter, Talent Acquisition).
- Prefer precise org names over stuffing them only into keywords.
- Use empty arrays when unknown. seniorities values: owner, founder, c_suite, partner, vp, head, director, manager, senior, entry.`,
    user: audienceQuery,
  });

  const parsed = JSON.parse(content) as AudienceFilters;
  const organizationNames =
    parsed.organizationNames?.map((n) => n.trim()).filter(Boolean) ?? [];
  let organizationDomains =
    parsed.organizationDomains?.map((d) => d.trim().replace(/^www\./, "")).filter(Boolean) ??
    [];

  if (!organizationDomains.length && organizationNames.length) {
    organizationDomains = organizationNames
      .map(guessDomainFromOrgName)
      .filter((d): d is string => Boolean(d));
  }

  return {
    titles: parsed.titles?.filter(Boolean) ?? [],
    locations: parsed.locations?.filter(Boolean) ?? [],
    industries: parsed.industries?.filter(Boolean) ?? [],
    keywords: parsed.keywords?.trim() || audienceQuery.trim(),
    seniorities: parsed.seniorities?.filter(Boolean) ?? [],
    organizationNames,
    organizationDomains,
  };
}
