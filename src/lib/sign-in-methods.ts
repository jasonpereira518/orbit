/**
 * Whether a sign-in method can be given up.
 *
 * The rule behind every branch: a person must keep at least one way back in. An unverified
 * email is not a way in, so it never counts as the spare that licenses removing something
 * that does — but it is still a row on the account, and the primary pointer still has to
 * land on something, so "unverified" does not mean "free to go" on its own.
 *
 * Deliberately free of React and of any Clerk import: the screens that call this cannot be
 * tested without a browser and live keys, so the rules live where a plain tsx script can
 * reach every branch. `signInMethodsFromUser` in `@/lib/clerk-sign-in-methods` is the single
 * adapter from Clerk’s user resource onto `SignInMethods`; no screen builds one by hand.
 *
 * The refusal strings say what is being protected, never what else the person has. A line
 * like "you’d have no way to sign in" is false for someone with Google connected, and "set a
 * password first" ignores email-code sign-in — both were shipped and both were wrong.
 */
export type SignInMethods = {
  /** Every email on the account, with whether Clerk has verified it. */
  emails: ReadonlyArray<{ id: string; verified: boolean }>;
  /**
   * Connected OAuth accounts that can actually be signed in through, by identification id.
   *
   * Verified ones only. `user.externalAccounts` mixes verified and unverified rows
   * (`UserResource` exposes `verifiedExternalAccounts` and `unverifiedExternalAccounts`
   * separately, `@clerk/shared/dist/types/user.d.mts:328-329`), and an unverified row is a
   * record of an abandoned or refused consent — not a way in. Counting one here would both
   * claim a sign-in method that does not exist and let the *real* last provider be
   * disconnected.
   */
  externalAccountIds: ReadonlyArray<string>;
  /** Whether a password is set. */
  hasPassword: boolean;
  /** The primary email’s id, or null. */
  primaryEmailId: string | null;
};

export type RemovalVerdict = { allowed: true } | { allowed: false; reason: string };

const ALLOWED: RemovalVerdict = { allowed: true };

function refuse(reason: string): RemovalVerdict {
  return { allowed: false, reason };
}

/**
 * Can this email be removed?
 *
 * Order matters, because the most protective reason should be the one shown:
 *
 * 1. The last address on the account never goes. Clerk’s server will happily remove it
 *    (`@clerk/ui/dist/common/RemoveResourceForm.js:12-22` calls `destroy()` with no checks of
 *    its own), leaving `primaryEmailAddressId` pointing at nothing.
 * 2. The primary never goes while it is primary — including an *unverified* primary, which
 *    a password sign-up or a promotion-before-verification can produce. The earlier rule
 *    returned early on `!verified` and so allowed exactly that.
 * 3. A non-primary unverified address goes freely: that is the abandoned add-flow row
 *    `add-email-dialog.tsx` deliberately leaves behind, and `email-list.tsx` deliberately
 *    lets go.
 * 4. The last *verified* address never goes, primary or not.
 */
export function canRemoveEmail(methods: SignInMethods, emailId: string): RemovalVerdict {
  const email = methods.emails.find((e) => e.id === emailId);
  if (!email) return refuse("That address isn’t on your account any more");

  if (methods.emails.length === 1) {
    return refuse("Orbit needs one address on your account");
  }

  const otherVerified = methods.emails.filter((e) => e.verified && e.id !== emailId);

  if (methods.primaryEmailId === emailId) {
    if (otherVerified.length === 0) {
      return refuse("Orbit needs one verified address on your account");
    }
    return refuse("That’s your primary address — make another one primary first");
  }

  // An unverified address that is not the primary cannot be signed in with and nothing
  // points at it, so losing it costs nothing.
  if (!email.verified) return ALLOWED;

  if (otherVerified.length === 0) {
    return refuse("Orbit needs one verified address on your account");
  }

  return ALLOWED;
}

/**
 * Can this connected account be disconnected?
 *
 * `externalAccountIds` carries verified accounts only — see its doc above. An unverified row
 * is never passed here at all: the screen renders a failed connection in its own block, with
 * a retry and a free removal, rather than asking this rule about an id it would not
 * recognise.
 */
export function canDisconnectAccount(
  methods: SignInMethods,
  identificationId: string
): RemovalVerdict {
  if (!methods.externalAccountIds.includes(identificationId)) {
    return refuse("That account isn’t connected any more");
  }

  if (methods.hasPassword) return ALLOWED;
  if (methods.externalAccountIds.length > 1) return ALLOWED;

  // Names the two things this rule actually checks, rather than claiming this is the only
  // way in — an email code may well be another.
  return refuse("Orbit needs a password or another connected account");
}
