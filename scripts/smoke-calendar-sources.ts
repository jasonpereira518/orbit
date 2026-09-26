/**
 * Three calendar mechanisms, one vocabulary — and no provider prose in any of it.
 *
 * The case worth protecting is `needs_permission`. A Google connection made for contacts has
 * no calendar scope, the scheduler parks calendar sync, and `deriveConnectionHealth` says
 * "active" — correctly, because a contacts-only grant is a choice. Today that combination is
 * completely silent. It has to read as an offer, and it must never read as broken.
 *
 * Pure tier: no database.
 *
 * Run: npx tsx scripts/smoke-calendar-sources.ts
 */
import {
  calendarSources,
  icsCalendarSource,
  providerCalendarSource,
  type IcsCalendarInput,
  type ProviderCalendarInput,
} from "../src/lib/imports/calendar-sources";

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(
    `  ${ok ? "ok  " : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`,
  );
  if (!ok) failures++;
}

const google = (
  over: Partial<ProviderCalendarInput> = {},
): ProviderCalendarInput => ({
  kind: "google",
  configured: true,
  connected: true,
  emailAddress: "jane@acme.example",
  status: "active",
  hasCalendarScope: true,
  syncError: null,
  lastSyncedAt: new Date().toISOString(),
  ...over,
});

const ics = (over: Partial<IcsCalendarInput> = {}): IcsCalendarInput => ({
  id: "sub1",
  label: null,
  icsUrl: "https://calendar.google.com/calendar/ical/abc/private-xyz/basic.ics",
  enabled: 1,
  lastSyncedAt: new Date(),
  lastSyncStatus: "ok",
  lastSyncError: null,
  ...over,
});

console.log("Provider calendars");
check(
  "a healthy connection is on",
  providerCalendarSource(google())?.state === "on",
);
check(
  "a syncing pass says so",
  providerCalendarSource(google({ syncStatus: "syncing" }))?.state ===
    "syncing",
);
check(
  "a dead grant asks for a reconnect",
  providerCalendarSource(google({ status: "needs_reauth" }))?.state ===
    "needs_reconnect",
);

const noScope = providerCalendarSource(
  google({
    hasCalendarScope: false,
    syncError: "Calendar access not granted — reconnect Google",
  }),
);
check(
  "a contacts-only grant is an offer, not a fault",
  noScope?.state === "needs_permission",
);
check(
  "...and reads as an invitation",
  /allow calendar access/i.test(noScope?.detail ?? ""),
  noScope?.detail,
);
check("...with an action attached", Boolean(noScope?.fix));
check(
  "...and never says anything went wrong",
  !/couldn’t|error|problem|wrong|paused/i.test(noScope?.detail ?? ""),
  noScope?.detail,
);

const disarmed = providerCalendarSource(
  google({
    status: "disarmed",
    syncError: "403 insufficient authentication scopes",
  }),
);
check("a disarmed sync is trouble", disarmed?.state === "trouble");
check(
  "...without echoing the provider body",
  !/403|insufficient|scopes/i.test(disarmed?.detail ?? ""),
  disarmed?.detail,
);

check(
  "an unconfigured provider is not offered",
  providerCalendarSource(google({ configured: false })) === null,
);
check(
  "a provider nobody connected is not offered",
  providerCalendarSource(google({ connected: false })) === null,
);
check(
  "Outlook is named for Microsoft, not Google",
  /Microsoft/.test(
    providerCalendarSource(google({ kind: "outlook", status: "needs_reauth" }))
      ?.fix?.label ?? "",
  ),
);

console.log("Link calendars");
check("a healthy subscription is on", icsCalendarSource(ics()).state === "on");
check(
  "a disabled one is paused, not broken",
  icsCalendarSource(ics({ enabled: 0 })).state === "paused",
);
check(
  "a failing one is trouble",
  icsCalendarSource(
    ics({ lastSyncStatus: "error", lastSyncError: "403 Forbidden" }),
  ).state === "trouble",
);
check(
  "...mapped, never echoed",
  !/403|Forbidden/.test(
    icsCalendarSource(
      ics({ lastSyncStatus: "error", lastSyncError: "403 Forbidden" }),
    ).detail,
  ),
);
check(
  "an unlabelled link is named by its host, not its secret URL",
  icsCalendarSource(ics()).name === "calendar.google.com",
  icsCalendarSource(ics()).name,
);
check(
  "...so the token never appears",
  !icsCalendarSource(ics()).name.includes("private-"),
  icsCalendarSource(ics()).name,
);
check(
  "a label wins when there is one",
  icsCalendarSource(ics({ label: "Work" })).name === "Work",
);
check(
  "a junk URL still gets a name",
  icsCalendarSource(ics({ icsUrl: "not a url" })).name === "Calendar",
);
check(
  "a webcal link is understood",
  icsCalendarSource(ics({ icsUrl: "webcal://p01.example.com/cal.ics" }))
    .name === "p01.example.com",
);

console.log("The list");
const all = calendarSources(
  [google(), google({ kind: "outlook", status: "needs_reauth" })],
  [
    ics({ id: "a", enabled: 0 }),
    ics({ id: "b", lastSyncStatus: "error", lastSyncError: "boom" }),
  ],
);
check("everything wired up is listed", all.length === 4, String(all.length));
check(
  "the broken one is first",
  all[0].state === "needs_reconnect",
  all[0].state,
);
check(
  "the paused one is last",
  all[all.length - 1].state === "paused",
  all[all.length - 1].state,
);
check(
  "no row exposes which mechanism it uses",
  all.every((r) => !/OAuth|ICS|iCal|scope|token|sync_error/i.test(r.detail)),
  all.map((r) => r.detail).join(" | "),
);
check(
  "every row has a name and a detail",
  all.every((r) => r.name && r.detail),
);
check(
  "no detail ends in a period or uses a straight apostrophe",
  all.every((r) => !r.detail.endsWith(".") && !r.detail.includes("'")),
  all.map((r) => r.detail).join(" | "),
);

if (failures) {
  console.error(
    `\n${failures} calendar source check${failures === 1 ? "" : "s"} failed`,
  );
  process.exit(1);
}
console.log("\ncalendar source smoke tests passed");
process.exit(0);
