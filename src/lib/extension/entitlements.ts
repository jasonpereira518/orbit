/**
 * What the extension may do for an account — the one place that decides it.
 *
 * `/me` reports these to the panel so it can draw locked sections without
 * asking, and `extensionRoute` enforces them on the routes behind each lock.
 * Both read `extensionFeatures`, so what the panel shows as locked and what the
 * server refuses cannot drift apart.
 *
 * Pure: no database, no request. `getEntitlements` (which reads the database
 * and applies the demo-account exemption) is the caller's job.
 */
import { PLAN_LABELS, type Entitlements } from "@/lib/entitlements";
import type { ExtensionEntitlements, ExtensionFeature } from "./contract";

export const EXTENSION_FEATURES: readonly ExtensionFeature[] = [
  "starters",
  "workHistory",
  "company",
  "search",
];

export function extensionFeatures(ent: Entitlements): Record<ExtensionFeature, boolean> {
  const pro = ent.canUseExtensionPro;
  return { starters: pro, workHistory: pro, company: pro, search: pro };
}

export function extensionEntitlements(
  ent: Entitlements,
  contactCount: number
): ExtensionEntitlements {
  return {
    plan: ent.plan,
    planLabel: PLAN_LABELS[ent.plan],
    contactLimit: ent.contactLimit,
    contactsRemaining:
      ent.contactLimit === null ? null : Math.max(0, ent.contactLimit - contactCount),
    features: extensionFeatures(ent),
  };
}

/** Where a locked section sends the user. `from`/`feature` let pricing say why. */
export function extensionUpgradeUrl(appBaseUrl: string, feature: ExtensionFeature) {
  const url = new URL("/pricing", appBaseUrl);
  url.searchParams.set("from", "extension");
  url.searchParams.set("feature", feature);
  return url.toString();
}

/**
 * Copy for a refusal. It is shown verbatim by a panel that predates plans (a
 * v1 build renders any error's `message`), so it has to stand on its own.
 */
export const FEATURE_LOCKED_COPY: Record<ExtensionFeature, string> = {
  starters: "AI opening lines are part of Orbit Pro and Lifetime.",
  workHistory: "Capturing work history is part of Orbit Pro and Lifetime.",
  company: "Seeing who you know at a company is part of Orbit Pro and Lifetime.",
  search: "Smart search is part of Orbit Pro and Lifetime.",
};
