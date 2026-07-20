import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { userSettings } from "@/db/schema";
import { decrypt } from "@/lib/crypto";
import {
  LINKEDIN_REFRESH_BATCH_SIZE,
  type AudienceFilters,
  type NormalizedProspect,
} from "@/lib/outreach-types";

const APOLLO_SEARCH_URL = "https://api.apollo.io/api/v1/mixed_people/search";
const APOLLO_MATCH_URL = "https://api.apollo.io/api/v1/people/match";

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

function decryptKey(encrypted?: string | null) {
  if (!encrypted) return null;
  try {
    return decrypt(encrypted);
  } catch {
    return null;
  }
}

export async function getApolloApiKey(userId: string): Promise<string | null> {
  const db = await getDb();
  const settings = await db.query.userSettings.findFirst({
    where: eq(userSettings.userId, userId),
  });
  return decryptKey(settings?.apolloApiKeyEncrypted) || process.env.APOLLO_API_KEY || null;
}

export function hasApolloKey(userId: string, settings?: { apolloApiKeyEncrypted?: string | null }) {
  return Boolean(decryptKey(settings?.apolloApiKeyEncrypted) || process.env.APOLLO_API_KEY);
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
  // Prefer the most recent education (no end_date / latest start).
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
  return {
    firstName: person.first_name?.trim() || null,
    lastName: person.last_name?.trim() || null,
    title: person.title?.trim() || null,
    company: person.organization?.name?.trim() || null,
    email: person.email?.trim() || null,
    location: personLocation(person) || null,
    school: extractSchool(person),
    profileImageUrl: photo && !photo.includes("static.licdn.com/aero") ? photo : null,
    linkedinUrl: person.linkedin_url?.trim() || null,
  };
}

function normalizePerson(person: ApolloPerson): NormalizedProspect | null {
  const externalId = person.id;
  if (!externalId) return null;

  const fullName =
    person.name?.trim() ||
    [person.first_name, person.last_name].filter(Boolean).join(" ").trim();
  if (!fullName) return null;

  const phone =
    person.phone_numbers?.[0]?.sanitized_number ||
    person.phone_numbers?.[0]?.raw_number ||
    null;

  return {
    externalId,
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

function mockProspects(filters: AudienceFilters, page: number): NormalizedProspect[] {
  const keyword = filters.keywords || filters.titles?.[0] || "founder";
  const location = filters.locations?.[0] || "San Francisco";
  const base = (page - 1) * 10;

  return Array.from({ length: 10 }, (_, i) => {
    const n = base + i + 1;
    const first = ["Alex", "Jordan", "Taylor", "Morgan", "Casey", "Riley", "Sam", "Avery", "Quinn", "Blake"][i];
    const last = ["Chen", "Patel", "Nguyen", "Brooks", "Kim", "Rivera", "Shah", "Davis", "Lee", "Martinez"][i];
    const company = `${keyword.split(" ")[0]} Labs ${n}`;
    return {
      externalId: `demo-${keyword.replace(/\s+/g, "-")}-${n}`,
      fullName: `${first} ${last}`,
      title: filters.titles?.[0] || `${keyword} at ${company}`,
      company,
      email: `${first.toLowerCase()}.${last.toLowerCase()}@${company.toLowerCase().replace(/\s+/g, "")}.com`,
      phone: n % 3 === 0 ? `+1415555${String(1000 + n).slice(-4)}` : null,
      linkedinUrl: `https://www.linkedin.com/in/${first.toLowerCase()}-${last.toLowerCase()}-${n}`,
      location,
      enrichment: { demo: true, keyword, page },
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
  if (filters.keywords?.trim()) {
    body.q_keywords = filters.keywords.trim();
  }

  return body;
}

export async function searchPeople(
  userId: string,
  filters: AudienceFilters,
  page = 1
): Promise<{ prospects: NormalizedProspect[]; total: number }> {
  const apiKey = await getApolloApiKey(userId);

  if (!apiKey) {
    return { prospects: mockProspects(filters, page), total: 50 };
  }

  const response = await fetch(APOLLO_SEARCH_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-cache",
      "X-Api-Key": apiKey,
    },
    body: JSON.stringify(buildSearchBody(filters, page)),
  });

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
  };
}

export async function enrichPerson(
  userId: string,
  externalId: string,
  hints?: { email?: string; linkedinUrl?: string; fullName?: string }
): Promise<NormalizedProspect | null> {
  const apiKey = await getApolloApiKey(userId);
  if (!apiKey || externalId.startsWith("demo-")) {
    return null;
  }

  const body: Record<string, unknown> = {};
  if (hints?.email) body.email = hints.email;
  if (hints?.linkedinUrl) body.linkedin_url = hints.linkedinUrl;
  if (hints?.fullName) body.name = hints.fullName;

  const response = await fetch(APOLLO_MATCH_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-cache",
      "X-Api-Key": apiKey,
    },
    body: JSON.stringify(body),
  });

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

  const apiKey = await getApolloApiKey(userId);
  if (!apiKey) {
    throw new Error(
      "Add an Apollo API key in Settings → Outreach to refresh LinkedIn profiles."
    );
  }

  const results: (LinkedInProfileEnrichment | null)[] = [];

  for (const person of people) {
    const body: Record<string, string> = {
      linkedin_url: person.linkedinUrl,
    };
    if (person.fullName?.trim()) body.name = person.fullName.trim();
    if (person.email?.trim()) body.email = person.email.trim();

    const response = await fetch(APOLLO_MATCH_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "no-cache",
        "X-Api-Key": apiKey,
      },
      body: JSON.stringify(body),
    });

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
    results.push(
      data.person ? normalizeLinkedInProfile(data.person) : null
    );
  }

  return results;
}

export async function parseAudienceToFilters(
  userId: string,
  audienceQuery: string
): Promise<AudienceFilters> {
  const { completeJson } = await import("@/lib/ai");
  const content = await completeJson(userId, {
    temperature: 0.1,
    system: `Extract structured Apollo people-search filters from a natural language audience description.
Return JSON:
{
  "titles": string[],
  "locations": string[],
  "industries": string[],
  "keywords": string,
  "seniorities": string[]
}
Use empty arrays when unknown. seniorities values: owner, founder, c_suite, partner, vp, head, director, manager, senior, entry.`,
    user: audienceQuery,
  });

  const parsed = JSON.parse(content) as AudienceFilters;
  return {
    titles: parsed.titles?.filter(Boolean) ?? [],
    locations: parsed.locations?.filter(Boolean) ?? [],
    industries: parsed.industries?.filter(Boolean) ?? [],
    keywords: parsed.keywords?.trim() || audienceQuery.trim(),
    seniorities: parsed.seniorities?.filter(Boolean) ?? [],
  };
}
