/**
 * Whether a sign-in method can be given up.
 *
 * The rule behind every branch: a person must keep at least one way back in. An unverified
 * email is not a way in, so it never counts on either side — it can always go, and it never
 * licenses removing something that does count.
 *
 * Deliberately free of React and of any Clerk import: the screens that call this cannot be
 * tested without a browser and live keys, so the rules live where a plain tsx script can
 * reach every branch. Callers map Clerk’s resources onto `SignInMethods` at the call site.
 */
export type SignInMethods = {
  /** Every email on the account, with whether Clerk has verified it. */
  emails: ReadonlyArray<{ id: string; verified: boolean }>;
  /** Connected OAuth accounts, by their identification id. */
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

/** Can this email be removed? */
export function canRemoveEmail(methods: SignInMethods, emailId: string): RemovalVerdict {
  const email = methods.emails.find((e) => e.id === emailId);
  if (!email) return refuse("That address isn’t on your account any more");

  // An unverified address cannot be signed in with, so losing it costs nothing.
  if (!email.verified) return ALLOWED;

  if (methods.primaryEmailId === emailId) {
    return refuse("That’s your primary address â make another one primary first");
  }

  const otherVerified = methods.emails.filter((e) => e.verified && e.id !== emailId);
  if (otherVerified.length === 0) {
    return refuse("That’s your only verified address â you’d have no way to sign in");
  }

  return ALLOWED;
}

/** Can this connected account be disconnected? */
export function canDisconnectAccount(
  methods: SignInMethods,
  identificationId: string
): RemovalVerdict {
  if (!methods.externalAccountIds.includes(identificationId)) {
    return refuse("That account isn’t connected any more");
  }

  if (methods.hasPassword) return ALLOWED;
  if (methods.externalAccountIds.length > 1) return ALLOWED;

  return refuse("That’s your only way to sign in â set a password first");
}
