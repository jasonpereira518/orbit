/**
 * KNOWN BUG — documented, not fixed.
 *
 * Symptom 1 — a calendar page can hang the sync forever. `fetchCalendarPage` passes no
 * `signal` to fetch, so a Graph connection that accepts the request and never answers keeps
 * that scheduler lane awaiting indefinitely: the per-connection deadline is only checked
 * BETWEEN pages (sync-scheduler.ts `syncMicrosoftCalendar`), so nothing ever fires. The pass
 * cannot return its stats or write its ledger row, and the platform kills the invocation
 * at its ceiling with the claimed connections still leased. Its siblings are bounded:
 * `fetchContactsPage` and `fetchCalendarWindow` pass `AbortSignal.timeout(20_000)`, and every
 * Google connector goes through `googleFetchWithRetry`'s per-attempt timeout.
 *
 * Symptom 2 — Graph throttling is a sync failure. A 429 (with `Retry-After`) or 503 from
 * Graph is thrown straight out of `fetchCalendarPage` and `fetchContactsPage`; the scheduler
 * records it as a failed sync, which walks the connection up the backoff ladder and, after
 * MAX_SYNC_FAILURES, disarms it (src/lib/provider-connections.ts). `src/lib/graph-fetch.ts`
 * exists precisely to wait these out ("Graph throttles per mailbox ... answers with 429 and a
 * Retry-After; 503/504 are its transient 'try again'"), and the Google calendar and contacts
 * connectors use their equivalent — the Microsoft ones do not.
 *
 * Defect: src/lib/connectors/microsoft-calendar.ts:~214 (`doFetch(url, { headers })`, no
 * signal, no retry) and src/lib/connectors/microsoft-contacts.ts:~151 (`doFetch` with a
 * timeout but no retry).
 *
 * Trigger path: `runSyncPass` → `syncMicrosoftConnection` → `syncMicrosoftCalendar` /
 * `syncMicrosoftContacts` → `fetchMicrosoftCalendarPage` / `fetchMicrosoftContactsPage`, the
 * defaults for `deps.fetchMicrosoftPage` / `deps.fetchMicrosoftContactsPage`.
 *
 * A fix (route both through `graphFetchWithRetry` with a `timeoutMs`, as `outlook.ts` does)
 * makes each `knownBug` hold; the script then exits 0 and belongs in the pure tier. Today the
 * test waits on nothing real: the hang is observed with a 300 ms race, not a 20 s timeout, and
 * the throttle answers fail on the first call. Once fixed, each throttle case costs one
 * ~0.5 s backoff (`Retry-After: 0` falls through to graph-fetch's first backoff step).
 *
 * Run: npx tsx scripts/smoke-bug-graph-sync-resilience.ts   (exits 3 while the bug exists)
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
      t.knownBug("BUG: fetchCalendarPage sends no AbortSignal, so a hung Graph request never times out", inits[1]?.signal instanceof AbortSignal, "init.signal is undefined");
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
        t.knownBug(`BUG: calendar — ${label} is thrown as a sync failure instead of retried`, err === null && http.calls.length === 2, `calls=${http.calls.length} error=${err instanceof Error ? err.message.slice(0, 60) : String(err)}`);
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
        t.knownBug(`BUG: contacts — ${label} is thrown as a sync failure instead of retried`, err === null && http.calls.length === 2, `calls=${http.calls.length} error=${err instanceof Error ? err.message.slice(0, 60) : String(err)}`);
      } finally {
        http.restore();
      }
    }
  }

  t.done("graph sync resilience (known bug)");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
