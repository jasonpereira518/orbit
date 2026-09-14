import { z } from "zod";
import { UserFacingError } from "@/lib/errors";
import { FUNDING_SOURCES, type OutreachFundingSource } from "@/lib/outreach/types";

/**
 * The one check on a funding source (spec §7.2), used at every server-action boundary AND
 * again inside every library entry point that spends on one — resolving providers, starting a
 * run, researching one person, saving the preference — so a crafted value is refused even by a
 * caller that forgot to check. Pure (zod + the error class), so it is safe anywhere.
 *
 * Callers branch on `=== "orbit"` / `=== "personal"` explicitly after this, never on "not
 * personal": that shape once read any unrecognised string as Orbit funding, which skipped both
 * the daily Orbit-search cap and the credit hold — unlimited Orbit-keyed searching, never
 * charged.
 */
export const fundingSourceSchema = z.enum(FUNDING_SOURCES);

export function parseFundingSource(value: unknown): OutreachFundingSource {
  const parsed = fundingSourceSchema.safeParse(value);
  if (!parsed.success) throw new UserFacingError("Choose Orbit’s allowance or your own keys to pay for this");
  return parsed.data;
}
