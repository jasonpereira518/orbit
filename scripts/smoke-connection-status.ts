/**
 * How a connection row reads to a person: active, session expired, or calendar sync paused.
 * Pure — the same derivation feeds the cards, the Integrations nav and the account bell.
 *
 * Run: npx tsx scripts/smoke-connection-status.ts
 */
import {
  CALENDAR_PAUSED_SHORT,
  SESSION_EXPIRED_LINE,
  calendarPauseLine,
  connectionSummary,
  deriveConnectionHealth,
} from "../src/lib/connection-status";

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

const row = (over: Partial<Parameters<typeof deriveConnectionHealth>[0]> = {}) => ({
  status: "active", nextSyncAt: new Date() as Date | null, syncError: null as string | null,
  calendarScopeGranted: true, ...over,
});

console.log("deriveConnectionHealth");
check("a healthy armed row is active", deriveConnectionHealth(row()) === "active");
check("needs_reauth wins over everything", deriveConnectionHealth(row({ status: "needs_reauth", nextSyncAt: null, syncError: "x" })) === "needs_reauth");
check("parked with an error is disarmed", deriveConnectionHealth(row({ nextSyncAt: null, syncError: "Google Calendar 403" })) === "disarmed");
check("in backoff (still scheduled) is not disarmed", deriveConnectionHealth(row({ syncError: "Google Calendar 503" })) === "active");
check("never scheduled, no error, is not disarmed", deriveConnectionHealth(row({ nextSyncAt: null })) === "active");
check("no calendar scope is never disarmed", deriveConnectionHealth(row({ nextSyncAt: null, syncError: "Calendar access not granted", calendarScopeGranted: false })) === "active");

console.log("calendarPauseLine");
check("scope trouble asks for calendar access", calendarPauseLine("Google Calendar 403: insufficient scope") === "Calendar sync paused — reconnect Google and allow calendar access");
check("anything else asks to reconnect", calendarPauseLine("Google Calendar 503: upstream") === "Calendar sync paused — reconnect Google to start it again");
check("never repeats the raw provider text", !calendarPauseLine('{"error":"secret"}').includes("secret"));

console.log("connectionSummary");
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
check("unconfigured", same(connectionSummary({ configured: false, connected: false, status: null }), { state: "off", detail: "Unavailable" }));
check("expired", same(connectionSummary({ configured: true, connected: false, status: "needs_reauth" }), { state: "partial", detail: SESSION_EXPIRED_LINE }));
check("paused", same(connectionSummary({ configured: true, connected: true, status: "disarmed" }), { state: "partial", detail: CALENDAR_PAUSED_SHORT }));
check("connected", connectionSummary({ configured: true, connected: true, status: "active" }).detail === "Connected");
check("no row", connectionSummary({ configured: true, connected: false, status: null }).detail === "Not connected");

console.log("house voice");
for (const line of [SESSION_EXPIRED_LINE, calendarPauseLine(null), calendarPauseLine("scope")]) {
  check(`"${line}"`, !line.includes("'") && !line.endsWith(".") && !/failed/i.test(line));
}

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
