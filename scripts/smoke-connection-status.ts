/**
 * How a connection row reads to a person: active, session expired, or calendar sync paused.
 * Pure — the same derivation feeds the cards, the Integrations nav and the account bell.
 *
 * Run: npx tsx scripts/smoke-connection-status.ts
 */
import {
  SESSION_EXPIRED_LINE,
  calendarOffLine,
  calendarPauseLine,
  deriveConnectionHealth,
} from "../src/lib/connection-status";

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

const row = (over: Partial<Parameters<typeof deriveConnectionHealth>[0]> = {}) => ({
  status: "active", nextSyncAt: new Date() as Date | null, syncError: null as string | null,
  syncStatus: null as string | null, calendarScopeGranted: true, ...over,
});

console.log("deriveConnectionHealth");
check("a healthy armed row is active", deriveConnectionHealth(row()) === "active");
check("needs_reauth wins over everything", deriveConnectionHealth(row({ status: "needs_reauth", nextSyncAt: null, syncError: "x" })) === "needs_reauth");
check("parked with an error is disarmed", deriveConnectionHealth(row({ nextSyncAt: null, syncError: "Google Calendar 403" })) === "disarmed");
check("in backoff (still scheduled) is not disarmed", deriveConnectionHealth(row({ syncError: "Google Calendar 503" })) === "active");
check("never scheduled, no error, is not disarmed", deriveConnectionHealth(row({ nextSyncAt: null })) === "active");
check("no calendar scope is never disarmed", deriveConnectionHealth(row({ nextSyncAt: null, syncError: "Calendar access not granted", calendarScopeGranted: false })) === "active");
check("a connection the person paused reads paused", deriveConnectionHealth(row({ syncStatus: "paused", nextSyncAt: null })) === "paused");
check("paused wins over a stale error", deriveConnectionHealth(row({ syncStatus: "paused", nextSyncAt: null, syncError: "old" })) === "paused");
check("a failure is still disarmed", deriveConnectionHealth(row({ nextSyncAt: null, syncError: "Google Calendar 403" })) === "disarmed");
check("needs_reauth still wins over everything", deriveConnectionHealth(row({ status: "needs_reauth", syncStatus: "paused", nextSyncAt: null })) === "needs_reauth");

console.log("calendarPauseLine");
check("scope trouble asks for calendar access", calendarPauseLine("Google Calendar 403: insufficient scope") === "Calendar sync paused — reconnect Google and allow calendar access");
check("anything else asks to reconnect", calendarPauseLine("Google Calendar 503: upstream") === "Calendar sync paused — reconnect Google to start it again");
check("never repeats the raw provider text", !calendarPauseLine('{"error":"secret"}').includes("secret"));
check(
  "the Microsoft card says Microsoft, not Google",
  calendarPauseLine("Graph 503: upstream", "Microsoft") === "Calendar sync paused — reconnect Microsoft to start it again",
  calendarPauseLine("Graph 503: upstream", "Microsoft"),
);

console.log("calendarOffLine");
check(
  "names the switch, and the three-hop breadcrumb to it",
  calendarOffLine() === "Meetings are switched off — turn them on in Settings → Integrations → Google",
  calendarOffLine(),
);
check("never says reconnect — a consent screen fixes nothing here", !/reconnect/i.test(calendarOffLine()));
check(
  "the Microsoft card says Microsoft, not Google",
  calendarOffLine("Microsoft") === "Meetings are switched off — turn them on in Settings → Integrations → Microsoft",
  calendarOffLine("Microsoft"),
);

console.log("house voice");
for (const line of [
  SESSION_EXPIRED_LINE,
  calendarPauseLine(null),
  calendarPauseLine("scope"),
  calendarOffLine(),
  calendarOffLine("Microsoft"),
]) {
  check(`"${line}"`, !line.includes("'") && !line.endsWith(".") && !/failed/i.test(line));
}

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
