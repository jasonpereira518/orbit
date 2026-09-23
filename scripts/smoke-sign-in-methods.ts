/**
 * The rules that stop someone removing their last way to sign in.
 *
 * Every branch is exercised here because the UI cannot be: mounting Clerk’s user resource
 * needs a browser and real keys, so these rules live in a pure module precisely so a plain
 * tsx script can prove them.
 *
 * Run: npx tsx scripts/smoke-sign-in-methods.ts
 */
import {
  canDisconnectAccount,
  canRemoveEmail,
  type SignInMethods,
} from "../src/lib/sign-in-methods";
// The Clerk adapter's only runtime-bearing export. Everything it imports from Clerk is an
// `import type`, so it erases and this script can reach it without a browser or a fake user.
import { providerKey } from "../src/lib/clerk-sign-in-methods";

let failures = 0;

function check(label: string, condition: boolean, detail?: string) {
  if (condition) {
    console.log(`  ok  ${label}`);
  } else {
    failures += 1;
    console.error(`  FAIL ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

/** A password user with two verified emails — the comfortable case. */
const roomy: SignInMethods = {
  emails: [
    { id: "e1", verified: true },
    { id: "e2", verified: true },
  ],
  externalAccountIds: ["x1"],
  hasPassword: true,
  primaryEmailId: "e1",
};

console.log("\nemail removal");
check("a non-primary verified email can go when another remains", canRemoveEmail(roomy, "e2").allowed);

const primaryBlocked = canRemoveEmail(roomy, "e1");
check("the primary email cannot be removed", !primaryBlocked.allowed);
check(
  "and the reason says why",
  !primaryBlocked.allowed && primaryBlocked.reason.toLowerCase().includes("primary"),
  !primaryBlocked.allowed ? primaryBlocked.reason : ""
);

const onlyEmail: SignInMethods = {
  emails: [{ id: "e1", verified: true }],
  externalAccountIds: [],
  hasPassword: true,
  primaryEmailId: "e1",
};
const onlyEmailBlocked = canRemoveEmail(onlyEmail, "e1");
check("the last verified email cannot be removed", !onlyEmailBlocked.allowed);
check(
  "the reason says Orbit needs one address, without claiming anything about other methods",
  !onlyEmailBlocked.allowed && onlyEmailBlocked.reason === "Orbit needs one address on your account",
  !onlyEmailBlocked.allowed ? onlyEmailBlocked.reason : ""
);

// A verified email that is the last verified one, but not primary (primary is null).
const lastVerifiedNotPrimary: SignInMethods = {
  emails: [
    { id: "e1", verified: true },
    { id: "e2", verified: false },
  ],
  externalAccountIds: [],
  hasPassword: true,
  primaryEmailId: null,
};
const lastVerifiedBlocked = canRemoveEmail(lastVerifiedNotPrimary, "e1");
check("the last verified email is blocked even if not primary", !lastVerifiedBlocked.allowed);
check(
  "and the reason is that one verified address has to stay",
  !lastVerifiedBlocked.allowed &&
    lastVerifiedBlocked.reason === "Orbit needs one verified address on your account",
  !lastVerifiedBlocked.allowed ? lastVerifiedBlocked.reason : ""
);
check(
  "the reason claims nothing about the person's other sign-in methods",
  !lastVerifiedBlocked.allowed &&
    !/no way to sign in|set a password/i.test(lastVerifiedBlocked.reason),
  !lastVerifiedBlocked.allowed ? lastVerifiedBlocked.reason : ""
);

const unverifiedExtra: SignInMethods = {
  emails: [
    { id: "e1", verified: true },
    { id: "e2", verified: false },
  ],
  externalAccountIds: [],
  hasPassword: true,
  primaryEmailId: "e1",
};
check(
  "an unverified email can always go — it is not a way in",
  canRemoveEmail(unverifiedExtra, "e2").allowed
);
check(
  "an unverified email does not count as the spare that frees the primary",
  !canRemoveEmail(unverifiedExtra, "e1").allowed
);

/**
 * An UNVERIFIED primary address — the case the first version of the rule allowed away.
 *
 * It returned early on `!verified`, so removing this left `primaryEmailAddressId` pointing at
 * a row that no longer existed. Reachable ordinarily: a password sign-up whose address is not
 * verified yet, or a promotion made before verification. Clerk's server does not stop it
 * either — `@clerk/ui/dist/common/RemoveResourceForm.js:12-22` calls `destroy()` with no
 * primary check of its own.
 */
const unverifiedPrimaryWithSpare: SignInMethods = {
  emails: [
    { id: "e1", verified: false },
    { id: "e2", verified: true },
  ],
  externalAccountIds: [],
  hasPassword: true,
  primaryEmailId: "e1",
};
const unverifiedPrimarySpare = canRemoveEmail(unverifiedPrimaryWithSpare, "e1");
check("an unverified PRIMARY address cannot be removed", !unverifiedPrimarySpare.allowed);
check(
  "and with a verified spare the reason points at making another one primary",
  !unverifiedPrimarySpare.allowed && unverifiedPrimarySpare.reason.toLowerCase().includes("primary"),
  !unverifiedPrimarySpare.allowed ? unverifiedPrimarySpare.reason : ""
);
check(
  "and its one verified address stays too, non-primary though it is",
  !canRemoveEmail(unverifiedPrimaryWithSpare, "e2").allowed
);

const unverifiedPrimaryNoVerified: SignInMethods = {
  emails: [
    { id: "e1", verified: false },
    { id: "e2", verified: false },
  ],
  externalAccountIds: ["x1"],
  hasPassword: false,
  primaryEmailId: "e1",
};
const unverifiedPrimaryAlone = canRemoveEmail(unverifiedPrimaryNoVerified, "e1");
check(
  "an unverified primary with no verified address anywhere cannot be removed either",
  !unverifiedPrimaryAlone.allowed
);
check(
  "and that reason is the verified-address one",
  !unverifiedPrimaryAlone.allowed &&
    unverifiedPrimaryAlone.reason === "Orbit needs one verified address on your account",
  !unverifiedPrimaryAlone.allowed ? unverifiedPrimaryAlone.reason : ""
);
check(
  "its unverified non-primary sibling is still free to go",
  canRemoveEmail(unverifiedPrimaryNoVerified, "e2").allowed
);

const soleUnverified: SignInMethods = {
  emails: [{ id: "e1", verified: false }],
  externalAccountIds: ["x1"],
  hasPassword: false,
  primaryEmailId: null,
};
const soleUnverifiedBlocked = canRemoveEmail(soleUnverified, "e1");
check(
  "the only address on the account never goes, even unverified and even unpromoted",
  !soleUnverifiedBlocked.allowed
);
check(
  "and the reason is the one-address one",
  !soleUnverifiedBlocked.allowed &&
    soleUnverifiedBlocked.reason === "Orbit needs one address on your account",
  !soleUnverifiedBlocked.allowed ? soleUnverifiedBlocked.reason : ""
);

const unknownEmailBlocked = canRemoveEmail(roomy, "nope");
check("an unknown email id is refused", !unknownEmailBlocked.allowed);
check(
  "and the reason mentions it is not on the account",
  !unknownEmailBlocked.allowed && unknownEmailBlocked.reason.toLowerCase().includes("isn’t on your account"),
  !unknownEmailBlocked.allowed ? unknownEmailBlocked.reason : ""
);

console.log("\ndisconnecting an account");
check("a provider can go while a password remains", canDisconnectAccount(roomy, "x1").allowed);

const oauthOnly: SignInMethods = {
  emails: [{ id: "e1", verified: true }],
  externalAccountIds: ["x1"],
  hasPassword: false,
  primaryEmailId: "e1",
};
const lastWayIn = canDisconnectAccount(oauthOnly, "x1");
check("the only provider cannot go when there is no password", !lastWayIn.allowed);
check(
  "the reason names the two things the rule checks",
  !lastWayIn.allowed &&
    lastWayIn.reason === "Orbit needs a password or another connected account",
  !lastWayIn.allowed ? lastWayIn.reason : ""
);
check(
  "and does not claim this is the person's only way in — an email code may be another",
  !lastWayIn.allowed && !/only way to sign in/i.test(lastWayIn.reason),
  !lastWayIn.allowed ? lastWayIn.reason : ""
);

/**
 * One verified provider plus one UNVERIFIED one, no password.
 *
 * This is the lockout the adapter had to be fixed for. `user.externalAccounts` mixes verified
 * and unverified rows (`UserResource` exposes them separately,
 * `@clerk/shared/dist/types/user.d.mts:328-329`), and `createExternalAccount` writes its row
 * before consent — so one abandoned or refused connect made `externalAccountIds.length > 1`
 * and enabled Disconnect on the ONLY provider that actually worked. With no password set that
 * is exactly the lockout this module exists to prevent.
 *
 * `signInMethodsFromUser` now maps `user.verifiedExternalAccounts` only, so a fixture built
 * the way the adapter builds one has a single id here, and the rule refuses.
 */
const oneVerifiedOneAbandoned: SignInMethods = {
  emails: [{ id: "e1", verified: true }],
  // The unverified provider is deliberately NOT here — that is the adapter's contract.
  externalAccountIds: ["x-verified"],
  hasPassword: false,
  primaryEmailId: "e1",
};
const abandonedDoesNotCount = canDisconnectAccount(oneVerifiedOneAbandoned, "x-verified");
check(
  "an abandoned connect does not license disconnecting the provider that works",
  !abandonedDoesNotCount.allowed
);
check(
  "an unverified provider's id is not even recognised as connected",
  !canDisconnectAccount(oneVerifiedOneAbandoned, "x-unverified").allowed
);

const twoProviders: SignInMethods = {
  emails: [{ id: "e1", verified: true }],
  externalAccountIds: ["x1", "x2"],
  hasPassword: false,
  primaryEmailId: "e1",
};
check("one of two providers can go with no password", canDisconnectAccount(twoProviders, "x1").allowed);

const unknownAccountBlocked = canDisconnectAccount(roomy, "nope");
check("an unknown account id is refused", !unknownAccountBlocked.allowed);
check(
  "and the reason mentions it is not connected",
  !unknownAccountBlocked.allowed && unknownAccountBlocked.reason.toLowerCase().includes("isn’t connected"),
  !unknownAccountBlocked.allowed ? unknownAccountBlocked.reason : ""
);

console.log("\nprovider identity");
check("google is its own provider", providerKey("google") === "google");
check(
  "the legacy linkedin provider folds onto linkedin_oidc",
  providerKey("linkedin") === "linkedin_oidc",
  providerKey("linkedin")
);
check("linkedin_oidc is already the canonical key", providerKey("linkedin_oidc") === "linkedin_oidc");
check(
  "so a legacy connection and the offered strategy are the same provider",
  providerKey("linkedin") === providerKey("linkedin_oidc")
);
check("an unknown provider passes through unchanged", providerKey("notion") === "notion");

console.log("\nvoice");
const allReasons = [
  primaryBlocked,
  onlyEmailBlocked,
  lastVerifiedBlocked,
  unverifiedPrimarySpare,
  unverifiedPrimaryAlone,
  soleUnverifiedBlocked,
  unknownEmailBlocked,
  lastWayIn,
  abandonedDoesNotCount,
  unknownAccountBlocked,
];
for (const verdict of allReasons) {
  if (verdict.allowed) continue;
  const reason = verdict.reason;
  check(`"${reason}" has no trailing period`, !reason.endsWith("."), reason);
  check(`"${reason}" does not shout`, !reason.includes("!"), reason);
  check(
    `"${reason}" uses a typographic apostrophe if any`,
    !reason.includes("'"),
    reason
  );
  // Check for mojibake: Â/â or C1 control characters in the UTF-8 range
  check(
    `"${reason}" contains no mojibake (Â or â)`,
    !reason.includes("Â") && !reason.includes("â"),
    reason
  );
  check(
    `"${reason}" contains no C1 control characters`,
    !/[\u0080-\u009f]/.test(reason),
    reason
  );
}

if (failures > 0) {
  console.error(`\nsmoke-sign-in-methods: ${failures} failure(s)`);
  process.exit(1);
}
console.log("\nsmoke-sign-in-methods: all ok");
process.exit(0);
