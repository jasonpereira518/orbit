/**
 * The vocabulary of a warm-path lookup, and the one rule that turns paths into a word.
 * Pure and client-safe: chips and cards import from here.
 */
import type { ClosenessTier } from "@/db/schema";
import type { IdentityKind } from "@/lib/duplicates";

/** A person to look up, described by the identifiers `contact_identities` matches on. */
export type TargetIdentity = {
  email?: string | null;
  linkedinSlug?: string | null;
  phoneE164?: string | null;
  xHandle?: string | null;
  /** `companies.name_normalized` form, for "who knows anyone at this company". */
  companyNormalized?: string | null;
};

export type Teammate = { userId: string; name: string; email: string | null };

/**
 * A teammate knows the target directly. Deliberately no contact id: it is another tenant's.
 * Name, tier, and matched identity kind only — no closeness score (the locked decision).
 */
export type DirectPath = {
  teammate: Teammate;
  tier: ClosenessTier;
  matchedOn: IdentityKind;
};

/** A teammate knows people at the target's company. */
export type AccountPath = { teammate: Teammate; count: number; bestTier: ClosenessTier };

export type Warmth = "hot" | "warm" | "cool" | "cold";

export type WarmPath = { warmth: Warmth; direct: DirectPath[]; account: AccountPath[] };

export type WarmPathLookup =
  | { status: "no_team" }
  | { status: "not_sharing" }
  | { status: "ok"; path: WarmPath };

export const TIER_RANK: Record<ClosenessTier, number> = { inner: 0, mid: 1, outer: 2 };
export const WARMTH_RANK: Record<Warmth, number> = { hot: 0, warm: 1, cool: 2, cold: 3 };

/**
 * hot = someone close knows them; warm = a real acquaintance, or two loose ones; cool = one
 * loose one, or only a way into the company; cold = nothing.
 */
export function rankWarmth(
  direct: ReadonlyArray<{ tier: ClosenessTier }>,
  account: ReadonlyArray<unknown>
): Warmth {
  const n = (tier: ClosenessTier) => direct.filter((d) => d.tier === tier).length;
  if (n("inner") >= 1) return "hot";
  if (n("mid") >= 1 || n("outer") >= 2) return "warm";
  if (n("outer") === 1 || account.length > 0) return "cool";
  return "cold";
}

/** The `(kind, value)` probes a target contributes, blanks dropped. */
export function identityPairs(target: TargetIdentity): Array<{ kind: IdentityKind; value: string }> {
  const pairs: Array<{ kind: IdentityKind; value: string }> = [];
  if (target.email) pairs.push({ kind: "email", value: target.email });
  if (target.linkedinSlug) pairs.push({ kind: "linkedin_slug", value: target.linkedinSlug });
  if (target.phoneE164) pairs.push({ kind: "phone_e164", value: target.phoneE164 });
  if (target.xHandle) pairs.push({ kind: "x_handle", value: target.xHandle });
  return pairs;
}
