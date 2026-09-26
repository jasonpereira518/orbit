/**
 * What the control on the right of each feature row is, for every state a capability can be in.
 *
 * The account pages render one row per capability, and the row's control — Import contacts,
 * a meetings switch, Allow, Upgrade, or nothing at all — is decided by `rowControl`, not by
 * the component. Keeping the rules here means the Google and Microsoft pages cannot drift
 * apart, and that a state nobody has seen yet (a grant that lost its contacts access between
 * visits, a plan that expired mid-session) still has an answer written down.
 *
 * `undefined` is the state of every capability on an account that isn't connected: the
 * status builders return no capabilities at all there, and a row with nothing to say must
 * offer nothing to press rather than a Connect button the header already owns.
 *
 * Run: npx tsx scripts/smoke-account-rows.ts
 */
import {
  googleAccountStatus,
  microsoftAccountStatus,
  rowControl,
  type AccountCapability,
  type CapabilityState,
  type GoogleConnectionInput,
  type MicrosoftConnectionInput,
  type RowControl,
} from "../src/lib/integration-status";

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

/** One printable line per control, so a mismatch reads as a diff rather than as `false`. */
function describe(control: RowControl): string {
  switch (control.kind) {
    case "action":
      return `action "${control.label}"`;
    case "switch":
      return `switch ${control.on ? "on" : "off"}`;
    case "locked":
      return `locked "${control.label}"`;
    case "none":
      return "none";
  }
}

/** The table in the plan, verbatim. Adding a row here is how a new rule gets pinned. */
const TABLE: ReadonlyArray<[AccountCapability, CapabilityState | "—", string]> = [
  ["contacts", "available", 'action "Import contacts"'],
  ["contacts", "on", 'action "Check for new"'],
  ["contacts", "not_allowed", 'action "Allow"'],
  ["meetings", "on", "switch on"],
  ["meetings", "off", "switch off"],
  ["meetings", "paused", 'action "Fix"'],
  ["meetings", "not_allowed", 'action "Allow"'],
  ["inbox", "locked", 'locked "Upgrade"'],
  ["inbox", "available", 'action "Scan inbox"'],
  ["inbox", "not_allowed", 'action "Allow"'],
  ["send", "on", "none"],
  ["send", "not_allowed", 'action "Allow"'],
  ["contacts", "—", "none"],
  ["meetings", "—", "none"],
  ["inbox", "—", "none"],
  ["send", "—", "none"],
];

console.log("rowControl");
for (const [capability, state, expected] of TABLE) {
  const actual = describe(rowControl(capability, state === "—" ? undefined : { state }));
  check(`${capability} · ${state === "—" ? "no status" : state} → ${expected}`, actual === expected, actual);
}

console.log("\nthe labels obey the copy rules");
const LABELS = TABLE.flatMap(([capability, state]) => {
  const control = rowControl(capability, state === "—" ? undefined : { state });
  return control.kind === "action" || control.kind === "locked" ? [control.label] : [];
});
check("there are labels to check", LABELS.length > 0, String(LABELS.length));
for (const label of [...new Set(LABELS)]) {
  check(
    `"${label}" avoids the words that belong in Advanced`,
    !/\b(api|oauth|scope|token|webhook|ics|feed|endpoint|sync|byok)\b/i.test(label)
  );
  check(`"${label}" is sentence case, with no full stop`, /^[A-Z][^.]*$/.test(label));
}

console.log("\nthe rows a real Google account produces");
const google = (over: Partial<GoogleConnectionInput> = {}): GoogleConnectionInput => ({
  configured: true,
  connected: true,
  emailAddress: "jo@gmail.com",
  status: "active",
  syncError: null,
  canImportContacts: true,
  hasCalendarScope: true,
  canRead: false,
  canSend: false,
  ...over,
});
const free = googleAccountStatus(google(), { canUseRecruiters: false });
check(
  "a fresh free connection offers its contacts",
  describe(rowControl("contacts", free.capabilities.contacts)) === 'action "Import contacts"'
);
check(
  "logs its meetings",
  describe(rowControl("meetings", free.capabilities.meetings)) === "switch on"
);
check(
  "sells the inbox scan rather than starting one",
  describe(rowControl("inbox", free.capabilities.inbox)) === 'locked "Upgrade"'
);
check(
  "and offers to ask for mail before sending",
  describe(rowControl("send", free.capabilities.send)) === 'action "Allow"'
);

const pro = googleAccountStatus(google({ canRead: true, canSend: true }), { canUseRecruiters: true });
check(
  "a paid connection with mail can scan",
  describe(rowControl("inbox", pro.capabilities.inbox)) === 'action "Scan inbox"'
);
check("and has nothing left to ask for sending", describe(rowControl("send", pro.capabilities.send)) === "none");

const stopped = googleAccountStatus(google({ status: "disarmed", syncError: "Google Calendar 403" }), {
  canUseRecruiters: true,
});
check(
  "meetings that stopped on their own offer a fix, not a switch",
  describe(rowControl("meetings", stopped.capabilities.meetings)) === 'action "Fix"'
);
const switchedOff = googleAccountStatus(google({ status: "paused" }), { canUseRecruiters: true });
check(
  "meetings the person switched off stay a switch",
  describe(rowControl("meetings", switchedOff.capabilities.meetings)) === "switch off"
);

console.log("\nan account that isn’t connected offers nothing per row");
const notConnected = googleAccountStatus(google({ connected: false, status: null }), { canUseRecruiters: true });
const CAPABILITIES: readonly AccountCapability[] = ["contacts", "meetings", "inbox", "send"];
check(
  "every row is quiet until the account is connected",
  CAPABILITIES.every((c) => rowControl(c, notConnected.capabilities[c]).kind === "none")
);

console.log("\nMicrosoft reads the same way");
const microsoft = (over: Partial<MicrosoftConnectionInput> = {}): MicrosoftConnectionInput => ({
  configured: true,
  connected: true,
  emailAddress: "jo@outlook.com",
  status: "active",
  syncError: null,
  hasContactsScope: false,
  hasCalendarScope: true,
  hasMailScope: true,
  ...over,
});
const m = microsoftAccountStatus(microsoft(), { canUseRecruiters: true });
check(
  "contacts left unticked ask for themselves",
  describe(rowControl("contacts", m.capabilities.contacts)) === 'action "Allow"'
);
check("its inbox scan starts the same way", describe(rowControl("inbox", m.capabilities.inbox)) === 'action "Scan inbox"');
check(
  "and there is no send row to control",
  describe(rowControl("send", m.capabilities.send)) === "none"
);

if (failures > 0) {
  console.error(`\nsmoke-account-rows: ${failures} failure(s)`);
  process.exit(1);
}
console.log("\nsmoke-account-rows: all ok");
process.exit(0);
