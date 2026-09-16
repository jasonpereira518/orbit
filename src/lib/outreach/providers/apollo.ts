import { normalizeEmail } from "@/lib/outreach/identity";
import { fetchWithRetry } from "@/lib/outreach/providers/http";
import {
  isProviderError,
  type EnrichedPerson,
  type EnrichmentProvider,
  type FetchLike,
  type KeyCheck,
} from "@/lib/outreach/providers/types";
import type { OutreachEmailStatus } from "@/lib/outreach/types";

const APOLLO_MATCH = "https://api.apollo.io/api/v1/people/match";
const APOLLO_HEALTH = "https://api.apollo.io/v1/auth/health";

type ApolloPerson = {
  id?: string;
  name?: string;
  first_name?: string;
  last_name?: string;
  title?: string;
  email?: string | null;
  email_status?: string | null;
  linkedin_url?: string | null;
  city?: string | null;
  state?: string | null;
  country?: string | null;
  organization?: { name?: string | null; primary_domain?: string | null } | null;
  employment_history?: Array<{
    organization_name?: string | null;
    title?: string | null;
    current?: boolean | null;
    start_date?: string | null;
    end_date?: string | null;
  }>;
};

type Deps = { fetch?: FetchLike; sleep?: (ms: number) => Promise<void> };

/** Apollo's statuses → ours. Anything not positively verified is `unverified` (spec §7.5). */
export function mapApolloEmailStatus(raw: unknown): OutreachEmailStatus | null {
  if (typeof raw !== "string" || raw.trim() === "") return null;
  const value = raw.trim().toLowerCase();
  if (value === "verified") return "verified";
  if (value === "unavailable") return "unavailable";
  if (value === "bounced") return "bounced";
  return "unverified";
}

/** Apollo returns this literal when an email exists but was not revealed. It is not an email. */
const LOCKED_EMAIL = /not_unlocked|@domain\.com$/i;

export function createApolloEnrichment(apiKey: string, deps: Deps = {}): EnrichmentProvider {
  const fetchImpl = deps.fetch ?? ((url, init) => fetch(url, init));
  return {
    name: "apollo",
    async match(input, opts): Promise<EnrichedPerson | null> {
      const body: Record<string, unknown> = { reveal_personal_emails: false, reveal_phone_number: false };
      if (input.linkedinUrl) body.linkedin_url = input.linkedinUrl;
      else if (input.fullName) {
        body.name = input.fullName;
        if (input.organization) body.organization_name = input.organization;
        if (input.domain) body.domain = input.domain;
      } else {
        return null;
      }
      const response = await fetchWithRetry(
        fetchImpl,
        APOLLO_MATCH,
        {
          method: "POST",
          headers: { "Content-Type": "application/json", "Cache-Control": "no-cache", "X-Api-Key": apiKey },
          body: JSON.stringify(body),
          signal: opts?.signal,
        },
        { provider: "apollo", sleep: deps.sleep }
      );
      const data = (await response.json()) as { person?: ApolloPerson | null };
      const person = data.person;
      if (!person) return null;
      const rawEmail = person.email && !LOCKED_EMAIL.test(person.email) ? normalizeEmail(person.email) : null;
      return {
        apolloId: person.id ?? null,
        fullName: person.name ?? ([person.first_name, person.last_name].filter(Boolean).join(" ") || null),
        title: person.title ?? null,
        company: person.organization?.name ?? null,
        organizationDomain: person.organization?.primary_domain ?? null,
        location: [person.city, person.state, person.country].filter(Boolean).join(", ") || null,
        linkedinUrl: person.linkedin_url ?? null,
        email: rawEmail,
        emailStatus: rawEmail ? mapApolloEmailStatus(person.email_status) : null,
        employment: (person.employment_history ?? []).slice(0, 8).map((job) => ({
          title: job.title ?? null,
          organization: job.organization_name ?? null,
          current: Boolean(job.current),
          startDate: job.start_date ?? null,
          endDate: job.end_date ?? null,
        })),
      };
    },
  };
}

export async function verifyApolloKey(apiKey: string, deps: Deps = {}): Promise<KeyCheck> {
  const fetchImpl = deps.fetch ?? ((url, init) => fetch(url, init));
  try {
    await fetchWithRetry(
      fetchImpl,
      APOLLO_HEALTH,
      { method: "GET", headers: { "X-Api-Key": apiKey, "Cache-Control": "no-cache" } },
      { provider: "apollo", sleep: deps.sleep }
    );
    return "valid";
  } catch (err) {
    return isProviderError(err) && err.kind === "auth" ? "invalid" : "unverified";
  }
}
