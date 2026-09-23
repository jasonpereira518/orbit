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
  "the reason mentions it is the only verified address",
  !onlyEmailBlocked.allowed && onlyEmailBlocked.reason.toLowerCase().includes("only verified"),
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
  "and the reason is about being the only verified address",
  !lastVerifiedBlocked.allowed && lastVerifiedBlocked.reason.toLowerCase().includes("only verified"),
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
  "and the reason mentions the password",
  !lastWayIn.allowed && lastWayIn.reason.toLowerCase().includes("password"),
  !lastWayIn.allowed ? lastWayIn.reason : ""
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

console.log("\nvoice");
const allReasons = [
  primaryBlocked,
  onlyEmailBlocked,
  lastVerifiedBlocked,
  unknownEmailBlocked,
  lastWayIn,
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
