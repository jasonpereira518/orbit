import type { ExternalAccountResource, OAuthProvider, UserResource } from "@clerk/nextjs/types";
import type { SignInMethods } from "@/lib/sign-in-methods";

/**
 * The one adapter from Clerk’s user resource onto the lockout rules.
 *
 * It lives in its own module rather than beside the rules in `@/lib/sign-in-methods` because
 * it needs Clerk’s `UserResource` type, and the rules are deliberately Clerk-free so a plain
 * tsx script can reach every branch. Keeping the Clerk type here rather than re-declaring the
 * shape structurally is the point: the two hand-written copies this replaces had already
 * drifted apart on whether `verification` was optional, and only the real type makes `tsc`
 * settle that. (`EmailAddressResource.verification` is a required `VerificationResource`,
 * `@clerk/shared/dist/types/emailAddress.d.mts:20`; `ExternalAccountResource.verification` is
 * `VerificationResource | null`, `externalAccount.d.mts:27`. The optional-chained email form
 * was the wrong one.)
 *
 * Every type import here is `import type`, so nothing survives to runtime and a tsx smoke can
 * still import this module.
 */

/**
 * Clerk ships LinkedIn as two separate providers — `linkedin` (legacy) and `linkedin_oidc`
 * (current), both valid `OAuthProvider` values (`@clerk/shared/dist/types/oauth.d.mts:30,32`)
 * — for what a person thinks of as one LinkedIn account. Without folding them together, an
 * account carrying the legacy connection sits next to a "Connect LinkedIn" button offering
 * the other spelling.
 *
 * Keyed by the legacy name so the current one is the canonical key.
 */
const PROVIDER_ALIASES: Readonly<Record<string, string>> = {
  linkedin: "linkedin_oidc",
};

/**
 * One key per provider a person would call by one name. Used to decide whether a provider is
 * already connected, never to build a strategy to connect with.
 */
export function providerKey(provider: string): string {
  return PROVIDER_ALIASES[provider] ?? provider;
}

/** Clerk’s user resource, as the lockout rules see it. */
export function signInMethodsFromUser(user: UserResource): SignInMethods {
  return {
    emails: user.emailAddresses.map((e) => ({
      id: e.id,
      // `verification` is required on an email address; `status` is `VerificationStatus |
      // null`, so the comparison is what carries the null.
      verified: e.verification.status === "verified",
    })),
    // Verified only — see `SignInMethods.externalAccountIds`. `user.externalAccounts` mixes
    // both, and `createExternalAccount` writes its row before the person has consented to
    // anything, so the mixed list over-reports what the account can be signed in through.
    externalAccountIds: user.verifiedExternalAccounts.map((a) => a.identificationId),
    hasPassword: user.passwordEnabled,
    primaryEmailId: user.primaryEmailAddressId,
  };
}

/**
 * Connections a person can actually sign in through, and so the only ones the main list
 * renders and the only ones the offer filter suppresses.
 *
 * Clerk’s own screens draw the same line: `AddConnectedAccount`
 * (`@clerk/ui/dist/components/UserProfile/ConnectedAccountsMenu.js:89`) suppresses an offer
 * only for a provider in `user.verifiedExternalAccounts`.
 */
export function connectedAccounts(user: UserResource): ExternalAccountResource[] {
  return user.verifiedExternalAccounts;
}

/**
 * Connections that were attempted and refused — a row Clerk kept so the failure can be seen
 * and retried, not a sign-in method.
 *
 * The filter is Clerk’s: `ConnectedAccountsSection.js:44` renders
 * `[...user.verifiedExternalAccounts, ...user.unverifiedExternalAccounts.filter(a =>
 * a.verification?.error)]`. An unverified row with no recorded error is a consent screen the
 * person simply walked away from; there is nothing to report and nothing to retry, so it is
 * shown nowhere and the provider stays on offer.
 */
export function failedAccounts(user: UserResource): ExternalAccountResource[] {
  return user.unverifiedExternalAccounts.filter((a) => a.verification?.error);
}

/** The strategy that reconnects an existing account's provider. */
export function strategyForProvider(provider: OAuthProvider): `oauth_${OAuthProvider}` {
  // `OAuthStrategy` is `` `oauth_${OAuthProvider}` | CustomOAuthStrategy ``
  // (`@clerk/shared/dist/types/strategies.d.mts:34`), so this is exact rather than a cast.
  // Clerk prefers `account.verification?.strategy` with this as its fallback
  // (`ConnectedAccountsSection.js:72`), but that field is a plain `string | null` and would
  // need a cast to be passed back in, which would let a wrong value through silently.
  return `oauth_${provider}`;
}
