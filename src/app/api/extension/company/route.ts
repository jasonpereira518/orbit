import type {
  CompanyLookupRequest,
  CompanyLookupResponse,
} from "@/lib/extension/contract";
import { companyLookupRequestSchema } from "@/lib/extension/contract.schema";
import { extensionFeatures } from "@/lib/extension/entitlements";
import { extensionRoute, preflight } from "@/lib/extension/http";
import { lookupCompany } from "@/lib/extension/people";

export const dynamic = "force-dynamic";

/**
 * Who the user knows at the organization on the page. Serves both tiers, so
 * no `entitlement:` — the counts ("you know 4 people here") are free and are
 * the reason to upgrade; the names are Pro. No gate hit is recorded for a
 * free answer: the panel records one when the user clicks the lock.
 */
export const POST = extensionRoute<CompanyLookupRequest, CompanyLookupResponse>({
  schema: companyLookupRequestSchema,
  handler: ({ userId, input, entitlements }) =>
    lookupCompany(userId, input.org, {
      includePeople: extensionFeatures(entitlements).company,
    }),
});

export const OPTIONS = preflight;
