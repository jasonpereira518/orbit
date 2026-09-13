import type { SerpResult } from "@/lib/outreach/discovery/serp";
import type { OutreachEmailStatus } from "@/lib/outreach/types";

/** Replaceable-adapter seams (spec §4.3). Pure: no database, no global fetch. */
export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;
export type ProviderName = "brave" | "apollo" | "demo";
export type ProviderErrorKind = "auth" | "rate_limited" | "unavailable" | "bad_request";

export class ProviderError extends Error {
  readonly provider: ProviderName;
  readonly kind: ProviderErrorKind;
  readonly retryAfterMs?: number;

  constructor(provider: ProviderName, kind: ProviderErrorKind, message: string, retryAfterMs?: number) {
    super(message);
    this.name = "ProviderError";
    this.provider = provider;
    this.kind = kind;
    this.retryAfterMs = retryAfterMs;
  }
}

export function isProviderError(err: unknown): err is ProviderError {
  return err instanceof Error && err.name === "ProviderError";
}

export type SearchPage = { results: SerpResult[]; moreAvailable: boolean };

export interface SearchProvider {
  readonly name: "brave" | "demo";
  search(q: string, opts: { count: number; offset: number; signal?: AbortSignal }): Promise<SearchPage>;
}

export type EnrichedPerson = {
  apolloId: string | null;
  fullName: string | null;
  title: string | null;
  company: string | null;
  organizationDomain: string | null;
  location: string | null;
  linkedinUrl: string | null;
  email: string | null;
  emailStatus: OutreachEmailStatus | null;
  employment: Array<{
    title: string | null;
    organization: string | null;
    current: boolean;
    startDate: string | null;
    endDate: string | null;
  }>;
};

export interface EnrichmentProvider {
  readonly name: "apollo" | "demo";
  match(
    input: { linkedinUrl?: string | null; fullName?: string | null; organization?: string | null; domain?: string | null },
    opts?: { signal?: AbortSignal }
  ): Promise<EnrichedPerson | null>;
}

export type KeyCheck = "valid" | "invalid" | "unverified";
