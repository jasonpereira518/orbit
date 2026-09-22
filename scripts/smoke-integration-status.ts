/**
 * How each Integrations page reads at a glance: Google and Microsoft described per feature,
 * the one-line page statuses, and the attention strip's order.
 *
 * The old single "Connected" line showed Gmail as connected when mail access was never
 * granted; these checks keep each feature answering for itself.
 *
 * Run: npx tsx scripts/smoke-integration-status.ts
 */
import {
  accountPageStatus,
  aiPageStatus,
  attentionItems,
  googleAccountStatus,
  linkedinPageStatus,
  microsoftAccountStatus,
  overviewAction,
  remindersPageStatus,
  type GoogleConnectionInput,
  type MicrosoftConnectionInput,
} from "../src/lib/integration-status";

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

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
const microsoft = (over: Partial<MicrosoftConnectionInput> = {}): MicrosoftConnectionInput => ({
  configured: true,
  connected: true,
  emailAddress: "jo@outlook.com",
  status: "active",
  syncError: null,
  hasContactsScope: true,
  hasCalendarScope: true,
  hasMailScope: false,
  ...over,
});
const pro = { canUseRecruiters: true };
const free = { canUseRecruiters: false };

console.log("googleAccountStatus");
check("unconfigured server", googleAccountStatus(google({ configured: false }), pro).state === "not_configured");
check(
  "no connection row",
  googleAccountStatus(google({ connected: false, status: null, emailAddress: null }), pro).state === "not_connected"
);
check("expired grant", googleAccountStatus(google({ connected: false, status: "needs_reauth" }), pro).state === "needs_reauth");
const g = googleAccountStatus(google(), pro);
check("connected, with the account's email", g.state === "connected" && g.email === "jo@gmail.com");
check("contacts granted reads available", g.capabilities.contacts?.state === "available");
check("calendar granted reads on", g.capabilities.meetings?.state === "on");
check("mail never granted is not_allowed", g.capabilities.inbox?.state === "not_allowed");
check("send not granted is not_allowed", g.capabilities.send?.state === "not_allowed");
check(
  "contacts unticked on the consent screen",
  googleAccountStatus(google({ canImportContacts: false }), pro).capabilities.contacts?.state === "not_allowed"
);
check(
  "calendar unticked on the consent screen",
  googleAccountStatus(google({ hasCalendarScope: false }), pro).capabilities.meetings?.state === "not_allowed"
);
const paused = googleAccountStatus(google({ status: "disarmed", syncError: "Google Calendar 403" }), pro).capabilities
  .meetings;
check("sync that gave up reads paused", paused?.state === "paused");
check("paused detail never echoes the provider's error", !(paused?.detail ?? "").includes("403"), paused?.detail);
check("paused detail names the fix", /sign in to Google again/i.test(paused?.detail ?? ""), paused?.detail);
check(
  "a scope-shaped error asks for calendar access",
  /allow calendar access/.test(
    googleAccountStatus(google({ status: "disarmed", syncError: "insufficient scope" }), pro).capabilities.meetings
      ?.detail ?? ""
  )
);
check("inbox granted on Pro is available", googleAccountStatus(google({ canRead: true }), pro).capabilities.inbox?.state === "available");
check("inbox on free is locked, even when granted", googleAccountStatus(google({ canRead: true }), free).capabilities.inbox?.state === "locked");
check("send granted reads on", googleAccountStatus(google({ canSend: true }), pro).capabilities.send?.state === "on");
check(
  "not connected lists no features",
  Object.keys(googleAccountStatus(google({ connected: false, status: null }), pro).capabilities).length === 0
);

console.log("\nmeetings, off versus broken");
const off = googleAccountStatus(google({ status: "paused" }), pro).capabilities.meetings;
check("turned off reads off", off?.state === "off");
check("and says so plainly", off?.detail === "Off");
const broke = googleAccountStatus(google({ status: "disarmed", syncError: "x" }), pro).capabilities.meetings;
check("broken still reads paused", broke?.state === "paused");
check(
  "only the broken one is worth flagging",
  attentionItems({ accounts: { google: googleAccountStatus(google({ status: "paused" }), pro) }, ai: { ready: true } }).length === 0
);
check(
  "the page reads connected while meetings are off",
  accountPageStatus(googleAccountStatus(google({ status: "paused" }), pro)).state === "on"
);

console.log("\nmicrosoftAccountStatus");
const m = microsoftAccountStatus(microsoft(), pro);
check("connected, with the account's email", m.state === "connected" && m.email === "jo@outlook.com");
check("Microsoft has no send feature", m.capabilities.send === undefined);
check("mail not granted", m.capabilities.inbox?.state === "not_allowed");
check("mail granted on Pro", microsoftAccountStatus(microsoft({ hasMailScope: true }), pro).capabilities.inbox?.state === "available");
check("mail on free is locked", microsoftAccountStatus(microsoft({ hasMailScope: true }), free).capabilities.inbox?.state === "locked");
check(
  "paused detail names Microsoft",
  /Microsoft/.test(microsoftAccountStatus(microsoft({ status: "disarmed", syncError: "x" }), pro).capabilities.meetings?.detail ?? "")
);

console.log("\naccountPageStatus");
check("unconfigured reads Unavailable", accountPageStatus(googleAccountStatus(google({ configured: false }), pro)).detail === "Unavailable");
const notConnected = accountPageStatus(googleAccountStatus(google({ connected: false, status: null }), pro));
check("not connected is off", notConnected.state === "off" && notConnected.detail === "Not connected");
const expired = accountPageStatus(googleAccountStatus(google({ connected: false, status: "needs_reauth" }), pro));
check("expired is partial, in plain words", expired.state === "partial" && expired.detail === "Sign in again", expired.detail);
const pausedPage = accountPageStatus(googleAccountStatus(google({ status: "disarmed", syncError: "x" }), pro));
check("paused meetings are partial", pausedPage.state === "partial" && pausedPage.detail === "Meetings paused");
const connectedPage = accountPageStatus(g);
check("connected names the account", connectedPage.state === "on" && connectedPage.detail === "Connected as jo@gmail.com");

console.log("\nother pages");
const now = new Date("2026-09-22T12:00:00Z");
const aiOff = aiPageStatus({ ready: false, providerLabel: "Google Gemini" });
check("AI off", aiOff.state === "off" && aiOff.detail === "Not on yet");
check("AI on names the provider", aiPageStatus({ ready: true, providerLabel: "Google Gemini" }).detail === "On · Google Gemini");
check("reminders off", remindersPageStatus({ enabled: false, lastFetchedAt: null }, now).detail === "Off");
check("reminders never checked", remindersPageStatus({ enabled: true, lastFetchedAt: null }, now).detail === "On · not checked yet");
const checkedAgo = remindersPageStatus({ enabled: true, lastFetchedAt: new Date("2026-09-22T10:00:00Z") }, now).detail;
check("reminders checked", checkedAgo === "On · checked about 2 hours ago", checkedAgo);
const never = linkedinPageStatus(null, now);
check("LinkedIn never imported", never.state === "off" && never.detail === "Not imported yet");
const imported = linkedinPageStatus(new Date("2026-09-13T12:00:00Z"), now);
check("LinkedIn imported", imported.state === "on" && imported.detail === "Imported 9 days ago", imported.detail);

console.log("\nattentionItems");
const items = attentionItems({
  accounts: {
    google: googleAccountStatus(google({ status: "disarmed", syncError: "x" }), pro),
    microsoft: microsoftAccountStatus(microsoft({ connected: false, status: "needs_reauth" }), pro),
  },
  ai: { ready: false },
});
check(
  "sign-in problems first, then paused meetings, then AI",
  items.map((i) => i.id).join(",") === "microsoft-reauth,google-meetings,ai-off",
  items.map((i) => i.id).join(",")
);
check("every item opens a page", items.every((i) => ["google", "microsoft", "ai"].includes(i.tab)));
check("unknown lookups add nothing", attentionItems({ accounts: { google: "unknown" }, ai: "unknown" }).length === 0);
check("healthy accounts and AI on add nothing", attentionItems({ accounts: { google: g, microsoft: m }, ai: { ready: true } }).length === 0);

console.log("\noverviewAction");
const label = (...args: Parameters<typeof overviewAction>) => overviewAction(...args).label;
const offGoogle = googleAccountStatus(google({ connected: false, status: null }), pro);
check("an unconnected account offers Connect", label("google", accountPageStatus(offGoogle), offGoogle) === "Connect Google");
check("Connect is the primary action", overviewAction("google", accountPageStatus(offGoogle), offGoogle).primary);
const offMicrosoft = microsoftAccountStatus(microsoft({ connected: false, status: null }), pro);
check("names Microsoft", label("microsoft", accountPageStatus(offMicrosoft), offMicrosoft) === "Connect Microsoft");
const expiredGoogle = googleAccountStatus(google({ connected: false, status: "needs_reauth" }), pro);
check("an expired account offers Sign in again", label("google", accountPageStatus(expiredGoogle), expiredGoogle) === "Sign in again");
check("a connected account offers Manage", label("google", accountPageStatus(g), g) === "Manage");
check("a still-loading account offers Open", label("google", undefined, undefined) === "Open");
check("an unavailable account offers Open", label("google", undefined, googleAccountStatus(google({ configured: false }), pro)) === "Open");
check("LinkedIn never imported", label("linkedin", linkedinPageStatus(null, now)) === "Import");
check("LinkedIn imported before", label("linkedin", linkedinPageStatus(new Date("2026-09-01T00:00:00Z"), now)) === "Import again");
check("AI off", label("ai", aiOff) === "Turn on AI" && overviewAction("ai", aiOff).primary);
check("AI on", label("ai", aiPageStatus({ ready: true, providerLabel: null })) === "Manage");
check("assistants", label("assistants", { state: "none", detail: "" }) === "Set up");
check("reminders off", label("reminders", remindersPageStatus({ enabled: false, lastFetchedAt: null }, now)) === "Set up");
check("reminders on", label("reminders", remindersPageStatus({ enabled: true, lastFetchedAt: null }, now)) === "Manage");

if (failures > 0) {
  console.error(`\nsmoke-integration-status: ${failures} failure(s)`);
  process.exit(1);
}
console.log("\nsmoke-integration-status: all ok");
process.exit(0);
