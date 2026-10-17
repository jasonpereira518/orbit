/**
 * Microsoft calendar and contacts sync pages are bounded in time and wait out Graph throttling.
 *
 * Pins: `fetchCalendarPage` (src/lib/connectors/microsoft-calendar.ts) sends an AbortSignal, so
 * a Graph connection that accepts the request and never answers cannot hold a scheduler lane
 * past the platform ceiling (the per-connection deadline is only checked between pages); and
 * both `fetchCalendarPage` and `fetchContactsPage` (src/lib/connectors/microsoft-contacts.ts)
 * retry a 429 (`Retry-After`) or 503 and return the next good answer instead of throwing.
 *
 * Why: a thrown throttle was recorded as a failed sync, walking the connection up the backoff
 * ladder and, after MAX_SYNC_FAILURES, disarming it — for Graph saying "later". The fix routes
 * both readers through `graphFetchWithRetry` (src/lib/graph-fetch.ts) with a 20 s per-attempt
 * timeout, as outlook.ts and the Google connectors' equivalent already do. The hang is
 * observed with a 300 ms race; each throttle case costs one ~0.5 s backoff (`Retry-After: 0`
 * falls through to graph-fetch's first backoff step).
 *
 * Run: npx tsx scripts/smoke-graph-sync-resilience.ts
 */
import { fetchCalendarPage } from "../src/lib/connectors/microsoft-calendar";
import { fetchContactsPage } from "../src/lib/connectors/microsoft-contacts";
import { checker } from "./smoke/check";
import { makeContact } from "./smoke/factories";
import { hang, json, mockFetch, route, status } from "./smoke/http-mock";

const t = checker();
const TOKEN = "EwB4A8l6.test-graph-token-not-real";
const OWNER = makeContact(0);
const GRAPH_429 = {
  error: { code: "TooManyRequests", message: "Too many requests", innerError: { date: "2026-10-17T00:00:00", "request-id": "00000000-0000-0000-0000-000000000000" } },
};

/** Records the init each request was made with, then answers through the http-mock. */
function recordingFetch(inits: RequestInit[]): typeof fetch {
  return (input, init) => {
    inits.push(init ?? {});
    return globalThis.fetch(input, init);
  };
}

/** Settles within `ms`, or reports that it did not. */
async function settlesWithin(p: Promise<unknown>, ms: number): Promise<"resolved" | "rejected" | "pending"> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<"pending">((resolve) => {
    timer = setTimeout(() => resolve("pending"), ms);
  });
  const settled = p.then(
    () => "resolved" as const,
    () => "rejected" as const
  );
  const out = await Promise.race([settled, timeout]);
  clearTimeout(timer);
  return out;
}

async function main() {
  console.log("A Graph that never answers");
  {
    const inits: RequestInit[] = [];
    const http = mockFetch([
      route("GET", /calendarView\/delta/, () => hang()),
      route("GET", /\/me\/contacts/, () => hang()),
    ]);
    try {
      const contacts = fetchContactsPage({ accessToken: TOKEN, cursor: null, fetchImpl: recordingFetch(inits) });
      contacts.catch(() => {});
      t.check("control: contacts pages carry a timeout signal", inits[0]?.signal instanceof AbortSignal);

      const calendar = fetchCalendarPage({ accessToken: TOKEN, cursor: null, ownerEmail: OWNER.email, fetchImpl: recordingFetch(inits) });
      calendar.catch(() => {});
      t.check("fetchCalendarPage sends an AbortSignal, so a hung Graph request times out", inits[1]?.signal instanceof AbortSignal, "init.signal is undefined");
      const state = await settlesWithin(calendar, 300);
      t.check("…and the page is indeed still pending (the request is hung, not failed)", state === "pending", state);
    } finally {
      http.restore();
    }
  }

  console.log("\nGraph throttling: 429 then 200");
  for (const [label, throttle] of [
    ["429 with Retry-After", () => status(429, GRAPH_429, { "retry-after": "0" })],
    ["503 Service Unavailable", () => status(503, { error: { code: "serviceNotAvailable", message: "Service unavailable" } })],
  ] as const) {
    {
      let n = 0;
      const http = mockFetch([
        route("GET", /calendarView\/delta/, () => (n++ === 0 ? throttle() : json({ value: [], "@odata.deltaLink": "https://graph.microsoft.com/v1.0/me/calendarView/delta?$deltatoken=x" }))),
      ]);
      try {
        let err: unknown = null;
        try {
          await fetchCalendarPage({ accessToken: TOKEN, cursor: null, ownerEmail: OWNER.email });
        } catch (e) {
          err = e;
        }
        t.check(`calendar — ${label} is retried, not thrown as a sync failure`, err === null && http.calls.length === 2, `calls=${http.calls.length} error=${err instanceof Error ? err.message.slice(0, 60) : String(err)}`);
      } finally {
        http.restore();
      }
    }
    {
      let n = 0;
      const http = mockFetch([route("GET", /\/me\/contacts/, () => (n++ === 0 ? throttle() : json({ value: [] })))]);
      try {
        let err: unknown = null;
        try {
          await fetchContactsPage({ accessToken: TOKEN, cursor: null });
        } catch (e) {
          err = e;
        }
        t.check(`contacts — ${label} is retried, not thrown as a sync failure`, err === null && http.calls.length === 2, `calls=${http.calls.length} error=${err instanceof Error ? err.message.slice(0, 60) : String(err)}`);
      } finally {
        http.restore();
      }
    }
  }

  t.done("graph sync resilience");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
