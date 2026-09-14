import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { userSettings } from "@/db/schema";
import { decryptOrNull } from "@/lib/crypto";
import { isDemoAccount } from "@/lib/demo-account";
import { getEntitlements } from "@/lib/entitlements";
import { UserFacingError } from "@/lib/errors";
import { PROVIDER_COST_MICROS } from "@/lib/outreach/config";
import { parseFundingSource } from "@/lib/outreach/funding";
import { createApolloEnrichment } from "@/lib/outreach/providers/apollo";
import { createBraveSearch } from "@/lib/outreach/providers/brave";
import { createDemoEnrichment, createDemoSearch } from "@/lib/outreach/providers/demo";
import {
  isProviderError,
  type EnrichmentProvider,
  type FetchLike,
  type SearchProvider,
} from "@/lib/outreach/providers/types";
import type { OutreachFundingSource } from "@/lib/outreach/types";
import { recordUsage } from "@/lib/usage-events";

export type ResearchProviders = {
  funding: OutreachFundingSource;
  keyOwner: "user" | "orbit";
  demo: boolean;
  search: SearchProvider;
  enrichment: EnrichmentProvider | null;
};

export type ProviderResolver = (userId: string, funding: OutreachFundingSource) => Promise<ResearchProviders>;

function meteredSearch(provider: SearchProvider, userId: string, keyOwner: "user" | "orbit"): SearchProvider {
  return {
    name: provider.name,
    async search(q, opts) {
      const started = Date.now();
      try {
        const page = await provider.search(q, opts);
        recordUsage({
          userId, operation: "outreach.search", provider: "brave", model: "web-search", kind: "search", keyOwner,
          success: true, durationMs: Date.now() - started, estimatedCostMicros: PROVIDER_COST_MICROS.braveSearch,
        });
        return page;
      } catch (err) {
        recordUsage({
          userId, operation: "outreach.search", provider: "brave", model: "web-search", kind: "search", keyOwner,
          success: false, errorKind: isProviderError(err) ? err.kind : "error", durationMs: Date.now() - started,
          estimatedCostMicros: 0,
        });
        throw err;
      }
    },
  };
}

function meteredEnrichment(provider: EnrichmentProvider, userId: string, keyOwner: "user" | "orbit"): EnrichmentProvider {
  return {
    name: provider.name,
    async match(input, opts) {
      const started = Date.now();
      try {
        const person = await provider.match(input, opts);
        recordUsage({
          userId, operation: "outreach.enrich", provider: "apollo", model: "people-match", kind: "enrichment", keyOwner,
          success: true, durationMs: Date.now() - started,
          estimatedCostMicros: person ? PROVIDER_COST_MICROS.apolloMatch : 0,
        });
        return person;
      } catch (err) {
        recordUsage({
          userId, operation: "outreach.enrich", provider: "apollo", model: "people-match", kind: "enrichment", keyOwner,
          success: false, errorKind: isProviderError(err) ? err.kind : "error", durationMs: Date.now() - started,
          estimatedCostMicros: 0,
        });
        throw err;
      }
    },
  };
}

/**
 * The providers a run uses, fixed by its funding source (spec §7.2). A personal run with a
 * failing key fails; it NEVER falls back to Orbit's keys. Demo adapters only for demo
 * accounts with no Orbit key configured (spec §7.5).
 *
 * Fails closed on the funding source itself: exactly "personal" or exactly "orbit", each
 * branch named, and anything else refused — never "not personal, so Orbit".
 */
export async function resolveResearchProviders(
  userId: string,
  fundingInput: OutreachFundingSource,
  deps: { fetch?: FetchLike } = {}
): Promise<ResearchProviders> {
  const funding = parseFundingSource(fundingInput);
  if (funding === "personal") {
    const db = await getDb();
    const [settings] = await db
      .select({ brave: userSettings.braveApiKeyEncrypted, apollo: userSettings.apolloApiKeyEncrypted })
      .from(userSettings)
      .where(eq(userSettings.userId, userId));
    const braveKey = decryptOrNull(settings?.brave);
    if (!braveKey) {
      throw new UserFacingError("Add your Brave Search key in Settings to search with your own keys");
    }
    const apolloKey = decryptOrNull(settings?.apollo);
    return {
      funding,
      keyOwner: "user",
      demo: false,
      search: meteredSearch(createBraveSearch(braveKey, { fetch: deps.fetch }), userId, "user"),
      enrichment: apolloKey ? meteredEnrichment(createApolloEnrichment(apolloKey, { fetch: deps.fetch }), userId, "user") : null,
    };
  }

  if (funding === "orbit") {
    const entitlements = await getEntitlements(userId);
    if (!entitlements.canUseOutreach) {
      throw new UserFacingError("Research on Orbit’s allowance is part of Orbit Pro and Orbit Lifetime");
    }
    const braveKey = process.env.BRAVE_SEARCH_API_KEY?.trim();
    if (!braveKey) {
      if (isDemoAccount(userId)) {
        return { funding, keyOwner: "orbit", demo: true, search: createDemoSearch(), enrichment: createDemoEnrichment() };
      }
      throw new UserFacingError("People search isn’t available right now — try again later or use your own keys");
    }
    const apolloKey = process.env.APOLLO_API_KEY?.trim();
    return {
      funding,
      keyOwner: "orbit",
      demo: false,
      search: meteredSearch(createBraveSearch(braveKey, { fetch: deps.fetch }), userId, "orbit"),
      enrichment: apolloKey ? meteredEnrichment(createApolloEnrichment(apolloKey, { fetch: deps.fetch }), userId, "orbit") : null,
    };
  }

  // Unreachable while `parseFundingSource` is the gate above — kept so a future third source
  // added to FUNDING_SOURCES is refused here until it gets a branch of its own.
  throw new UserFacingError("Choose Orbit’s allowance or your own keys to pay for this");
}
