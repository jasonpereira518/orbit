/**
 * Apollo search, shaped for the Leads page: the form's comma-separated fields become Apollo
 * filters, and a prospect becomes a lead input and a view the client may hold. Pure.
 */
import type { AudienceFilters, NormalizedProspect, OutreachSearchSource } from "@/lib/outreach-types";
import type { LeadInput } from "./lead-identity";
import type { WarmPath } from "./warm-path";

export type ApolloSearchInput = { titles: string; companies: string; locations: string; keywords: string };

export type ApolloProspectView = {
  externalId: string;
  fullName: string;
  title: string | null;
  company: string | null;
  email: string | null;
  phone: string | null;
  linkedinUrl: string | null;
  location: string | null;
  /** Invented by `searchPeople` because there is no Apollo key. */
  demo: boolean;
};

export type ApolloLeadRow = { prospect: ApolloProspectView; path: WarmPath | null };

export type ApolloLeadSearch = {
  rows: ApolloLeadRow[];
  total: number;
  source: OutreachSearchSource;
  team: "ok" | "no_team" | "not_sharing";
  page: number;
};

/** Apollo pages are ten people; twenty pages is far past what anyone scrolls. */
export const APOLLO_MAX_PAGE = 20;

function listField(value: unknown, max = 10): string[] | undefined {
  if (typeof value !== "string") return undefined;
  const items = [
    ...new Set(
      value
        .split(",")
        .map((item) => item.trim().slice(0, 100))
        .filter(Boolean)
    ),
  ].slice(0, max);
  return items.length ? items : undefined;
}

export function apolloFiltersFromInput(raw: unknown): AudienceFilters {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const keywords = typeof r.keywords === "string" ? r.keywords.trim().slice(0, 200) : "";
  return {
    titles: listField(r.titles),
    organizationNames: listField(r.companies),
    locations: listField(r.locations),
    keywords: keywords || undefined,
  };
}

export function isEmptySearch(filters: AudienceFilters): boolean {
  return (
    !filters.titles?.length &&
    !filters.organizationNames?.length &&
    !filters.locations?.length &&
    !filters.keywords
  );
}

export function prospectLeadInput(
  p: Pick<ApolloProspectView, "fullName" | "title" | "company" | "email" | "phone" | "linkedinUrl">
): LeadInput {
  return {
    displayName: p.fullName,
    title: p.title,
    companyName: p.company,
    email: p.email,
    phone: p.phone,
    linkedinUrl: p.linkedinUrl,
  };
}

export function prospectView(p: NormalizedProspect, source: OutreachSearchSource): ApolloProspectView {
  return {
    externalId: p.externalId,
    fullName: p.fullName,
    title: p.title,
    company: p.company,
    email: p.email,
    phone: p.phone,
    linkedinUrl: p.linkedinUrl,
    location: p.location,
    demo: source === "demo" || p.enrichment?.demo === true,
  };
}

/** A prospect posted back from the client, checked field by field before it is saved. */
export function coerceProspect(raw: unknown): ApolloProspectView | null {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const text = (value: unknown) =>
    typeof value === "string" && value.trim() ? value.trim().slice(0, 300) : null;
  const externalId = text(r.externalId);
  const fullName = text(r.fullName);
  if (!externalId || !fullName) return null;
  return {
    externalId,
    fullName,
    title: text(r.title),
    company: text(r.company),
    email: text(r.email),
    phone: text(r.phone),
    linkedinUrl: text(r.linkedinUrl),
    location: text(r.location),
    demo: r.demo === true,
  };
}
