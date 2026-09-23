/**
 * The rules that stop someone removing their last way to sign in.
 *
 * Every branch is exercised here because the UI cannot be: mounting Clerk's user resource
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
check("the last verified email cannot be removed", !canRemoveEmail(onlyEmail, "e1").allowed);

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
check("an unknown email id is refused", !canRemoveEmail(roomy, "nope").allowed);

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
check("an unknown account id is refused", !canDisconnectAccount(roomy, "nope").allowed);

console.log("\nvoice");
for (const verdict of [primaryBlocked, canRemoveEmail(onlyEmail, "e1"), lastWayIn]) {
  if (verdict.allowed) continue;
  check(`"${verdict.reason}" has no trailing period`, !verdict.reason.endsWith("."), verdict.reason);
  check(`"${verdict.reason}" does not shout`, !verdict.reason.includes("!"), verdict.reason);
  check(
    `"${verdict.reason}" uses a typographic apostrophe if any`,
    !verdict.reason.includes("'"),
    verdict.reason
  );
}

if (failures > 0) {
  console.error(`\nsmoke-sign-in-methods: ${failures} failure(s)`);
  process.exit(1);
}
console.log("\nsmoke-sign-in-methods: all ok");
process.exit(0);
