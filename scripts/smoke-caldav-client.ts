/**
 * The CalDAV transport layer: discovery, calendar listing, and change fetching.
 *
 * Pure tier: `client.ts` issues no database statement — it only talks to `guardedFetchText`,
 * which is given a stubbed `fetchImpl` here, so nothing in this file touches a database or a
 * real network. THIS IS LOAD-BEARING for one specific reason: `guardedFetchText` calls
 * `recordErrorEvent` (which opens `getDb()`) when a RETRYABLE status (429 or 5xx) exhausts
 * its retry ladder — see `guarded-fetch.ts`. `recordErrorEvent` swallows its own exceptions,
 * so a script that triggered this would still pass whether or not the database write actually
 * happened, which is exactly what makes it dangerous rather than merely wrong: if
 * `DATABASE_URL` ever pointed at a real (shared) database while this script ran outside
 * `run-smoke.ts`'s harness, it would silently write a bogus `caldav.sync` row, invisibly. So:
 * NO fixture or stub response in this file may use status 429 or >=500. `networkFailure`
 * below exercises the same retry-ladder shape (a `fetch` failure retried and exhausted) for
 * exactly this reason — it goes through a DIFFERENT branch in `guarded-fetch.ts` that never
 * calls `recordErrorEvent` at all.
 *
 * The fixtures driving these checks are synthetic (see `src/lib/caldav/fixtures/index.ts`) —
 * Task 1's real-Apple spike has not run yet. What matters most here is not "does the XML
 * parse" but the properties this client exists to enforce: the password reaches
 * caldav.icloud.com (and its shard hosts) and nowhere else, even across a redirect; a 401
 * comes back as a distinct signal; a transient failure never gets confused with "this
 * calendar doesn't support X"; a stale sync-token triggers a resync, not a downgrade; and a
 * cursor is never advanced past data the client never actually saw.
 */
import {
  CalDavAuthError,
  CalDavRejectedError,
  CalDavStaleSyncTokenError,
  discoverPrincipal,
  fetchChanges,
  listCalendars,
  type CalDavCredentials,
} from "../src/lib/caldav/client";
import { EventPageError } from "../src/lib/events/guarded-fetch";
import {
  CALENDAR_HOME_PROPFIND_RESPONSE,
  CALENDAR_LIST_PROPFIND_RESPONSE,
  CALENDAR_QUERY_RESPONSE,
  CTAG_PROPFIND_RESPONSE,
  PRINCIPAL_PROPFIND_RESPONSE,
  SYNC_COLLECTION_RESPONSE,
} from "../src/lib/caldav/fixtures/index";

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

async function refuses(label: string, fn: () => Promise<unknown>, expect?: (err: unknown) => boolean) {
  try {
    await fn();
    check(label, false, "it was ALLOWED");
  } catch (error) {
    check(label, expect ? expect(error) : true, error instanceof Error ? error.message : String(error));
  }
}

type Call = { method: string; url: string; headers: Record<string, string>; body: string | null };

/** A stub `fetch` that answers a queued list of responses in order (repeating the last one
 *  once the queue is exhausted, so a retried request keeps getting an answer) and records
 *  every call it received — method, URL, headers, and body — so the checks can assert on the
 *  actual wire shape, not just the parsed result. */
function stubFetch(steps: Array<Response | (() => Response)>) {
  const calls: Call[] = [];
  const impl = (async (input: string | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const headers: Record<string, string> = {};
    if (init?.headers) {
      for (const [k, v] of Object.entries(init.headers as Record<string, string>)) headers[k.toLowerCase()] = v;
    }
    calls.push({
      method: init?.method ?? "GET",
      url,
      headers,
      body: typeof init?.body === "string" ? init.body : null,
    });
    const i = calls.length - 1;
    const step = steps[Math.min(i, steps.length - 1)];
    if (!step) throw new Error(`stubFetch: no step queued for call ${i} (${url})`);
    return typeof step === "function" ? step() : step;
  }) as unknown as typeof fetch;
  return { impl, calls };
}

function xml(body: string, status = 207) {
  return new Response(body, { status, headers: { "content-type": "application/xml; charset=utf-8" } });
}

function unauthorized() {
  return new Response("", { status: 401, headers: { "www-authenticate": 'Basic realm="caldav"' } });
}

function forbidden() {
  return new Response("", { status: 403, headers: { "content-type": "text/plain" } });
}

/** RFC 6578's `valid-sync-token` precondition — the server's answer to an invalid or expired
 *  `sync-token`, whose prescribed recovery is a full resync, not "unsupported". */
function staleSyncTokenRejected() {
  const body = `<?xml version="1.0" encoding="utf-8"?>\n<D:error xmlns:D="DAV:"><D:valid-sync-token/></D:error>`;
  return new Response(body, { status: 403, headers: { "content-type": "application/xml; charset=utf-8" } });
}

/** Simulates a network-level failure (a rejected `fetch`, as from a dropped connection or a
 *  DNS failure) rather than an HTTP error response. `guardedFetchText` retries this on the
 *  SAME ladder as a 429/5xx (three attempts, same backoff) and then throws — but through the
 *  branch in `guarded-fetch.ts` that never calls `recordErrorEvent`, unlike an exhausted
 *  retryable STATUS. See this file's header comment for why that distinction is load-bearing
 *  here. */
function networkFailure(): Response {
  throw new Error("stub: simulated network failure");
}

function redirect(to: string) {
  return new Response(null, { status: 302, headers: { location: to } });
}

/** Builds a fallback-path (ctag) cursor value in the grammar `client.ts` documents:
 *  `ctag:<probedAtEpochMs>:<value>`. Not imported from `client.ts` — the helpers that build
 *  and parse this are deliberately internal — so this stands in as an independent check that
 *  the documented grammar matches what the implementation actually produces and consumes. */
function ctagCursorFor(ctag: string, ageMs = 0): string {
  return `ctag:${Date.now() - ageMs}:${ctag}`;
}

/** A PROPFIND response padded well past `MAX_CALDAV_BYTES` (8,000,000 bytes), for proving the
 *  overflow behaviour is "error", not "truncate": a truncated response would parse into a
 *  clean-looking partial tree with no error at all — see `client.ts`'s comment on
 *  `onOverflow` in `davRequest`. */
function oversizedPropfindResponse(): Response {
  const filler = `<!--${"x".repeat(8_600_000)}-->`;
  const body =
    `<?xml version="1.0" encoding="utf-8"?>\n<D:multistatus xmlns:D="DAV:">${filler}` +
    `<D:response><D:href>/x/</D:href><D:propstat><D:prop>` +
    `<D:resourcetype><D:collection/></D:resourcetype></D:prop>` +
    `<D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response></D:multistatus>`;
  return xml(body);
}

const CREDS: CalDavCredentials = { username: "jason@icloud.com", password: "app-specific-secret-do-not-log" };

async function main() {
  console.log("\nprincipal discovery");
  {
    const { impl, calls } = stubFetch([xml(PRINCIPAL_PROPFIND_RESPONSE), xml(CALENDAR_HOME_PROPFIND_RESPONSE)]);
    const result = await discoverPrincipal(CREDS, { fetchImpl: impl });
    check(
      "principal discovery returns both URLs",
      result.principalUrl === "https://caldav.icloud.com/1234567/principal/" &&
        result.calendarHomeUrl === "https://caldav.icloud.com/1234567/calendars/",
      JSON.stringify(result)
    );
    check("both requests used PROPFIND", calls.every((c) => c.method === "PROPFIND"));
    check(
      "both requests carried the Authorization header",
      calls.every((c) => c.headers["authorization"] === `Basic ${Buffer.from(`${CREDS.username}:${CREDS.password}`).toString("base64")}`)
    );
    check("the principal request used Depth: 0", calls[0]?.headers["depth"] === "0", calls[0]?.headers["depth"]);
  }

  console.log("\ncalendar listing");
  {
    const { impl, calls } = stubFetch([xml(CALENDAR_LIST_PROPFIND_RESPONSE)]);
    const calendars = await listCalendars(CREDS, "https://caldav.icloud.com/1234567/calendars/", { fetchImpl: impl });
    check("the home collection itself is not returned as a calendar", calendars.length === 2, String(calendars.length));
    const home = calendars.find((c) => c.displayName === "Home");
    const shared = calendars.find((c) => c.displayName === "Ada's Birthdays");
    check("the owned calendar is not read-only", home?.readOnly === false);
    check("the owned calendar reports WebDAV-Sync support", home?.supportsSync === true);
    check("the owned calendar's ctag is read", home?.ctag === "3145", String(home?.ctag));
    check("a subscribed calendar is marked read-only", shared?.readOnly === true);
    check("a subscribed calendar with no sync-token reports no sync support", shared?.supportsSync === false);
    check("the listing request used Depth: 1", calls[0]?.headers["depth"] === "1", calls[0]?.headers["depth"]);
  }

  console.log("\nauth failure");
  {
    const { impl } = stubFetch([unauthorized()]);
    await refuses(
      "a 401 raises CalDavAuthError, not a generic error",
      () => discoverPrincipal(CREDS, { fetchImpl: impl }),
      (err) => err instanceof CalDavAuthError
    );
  }
  {
    // The password itself must never end up inside the thrown error.
    const { impl } = stubFetch([unauthorized()]);
    try {
      await discoverPrincipal(CREDS, { fetchImpl: impl });
      check("(unreachable)", false);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      check("the CalDavAuthError message does not contain the password", !message.includes(CREDS.password), message);
    }
  }

  console.log("\nsync-collection (WebDAV-Sync path)");
  {
    const { impl, calls } = stubFetch([xml(SYNC_COLLECTION_RESPONSE)]);
    const result = await fetchChanges(
      CREDS,
      "https://caldav.icloud.com/1234567/calendars/home/",
      { syncToken: "https://caldav.icloud.com/1234567/calendars/home/sync/1" },
      { from: new Date("2026-03-01T00:00:00Z"), to: new Date("2026-04-01T00:00:00Z") },
      { fetchImpl: impl }
    );
    check(
      "a sync-collection response yields its token, unprefixed (it is a real sync-token)",
      result.nextSyncToken === "https://caldav.icloud.com/1234567/calendars/home/sync/2",
      String(result.nextSyncToken)
    );
    check("the changed event's calendar-data comes back", result.icsDocuments.length === 1, String(result.icsDocuments.length));
    check("the ics document is the one from the fixture", result.icsDocuments[0]?.includes("UID:3b9f2@example.com") ?? false);
    check("deleted hrefs are counted as tombstones", result.tombstones === 1, String(result.tombstones));
    check("the request was a REPORT", calls[0]?.method === "REPORT", calls[0]?.method);
    check("the stored sync-token was sent, not a fresh one", calls[0]?.body?.includes("sync/1") ?? false);
  }

  console.log("\nfallback to ctag + time-range query (an unrecognised sync-token, or none yet)");
  {
    const { impl, calls } = stubFetch([
      forbidden(), // sync-collection REPORT: this calendar does not support it (or the token is stale)
      xml(CTAG_PROPFIND_RESPONSE), // ctag probe: "99"
      xml(CALENDAR_QUERY_RESPONSE), // time-range calendar-query
    ]);
    const result = await fetchChanges(
      CREDS,
      "https://caldav.icloud.com/1234567/calendars/no-sync/",
      { syncToken: "a-real-but-now-stale-sync-token" }, // unprefixed: not yet known to be unsupported
      { from: new Date("2026-03-01T00:00:00Z"), to: new Date("2026-04-01T00:00:00Z") },
      { fetchImpl: impl }
    );
    check("a calendar without sync support still returns events", result.icsDocuments.length === 1, String(result.icsDocuments.length));
    check(
      "the new ctag is returned prefixed with ctag:<probedAt>:<value>, so the NEXT call knows to skip the probe",
      /^ctag:\d+:99$/.test(result.nextSyncToken ?? ""),
      String(result.nextSyncToken)
    );
    check("the fallback path reports zero tombstones (it cannot see deletions)", result.tombstones === 0);
    check("three requests were made: REPORT, PROPFIND, REPORT", calls.length === 3, String(calls.length));
    check(
      "the fallback attempted sync-collection first, then fell back",
      calls[0]?.method === "REPORT" && calls[1]?.method === "PROPFIND" && calls[2]?.method === "REPORT",
      calls.map((c) => c.method).join(",")
    );
    check("the fallback time-range query carries the window", calls[2]?.body?.includes("time-range") ?? false);
  }

  console.log("\na known non-sync calendar (ctag-prefixed cursor) skips the probe entirely");
  {
    const { impl, calls } = stubFetch([xml(CTAG_PROPFIND_RESPONSE)]);
    const result = await fetchChanges(
      CREDS,
      "https://caldav.icloud.com/1234567/calendars/no-sync/",
      {
        syncToken: ctagCursorFor("99"), // already known: this calendar does not support sync-collection (fresh, not expired)
        windowStart: "2026-01-01T00:00:00Z", // covers the requested window below
        windowEnd: "2026-06-01T00:00:00Z",
      },
      { from: new Date("2026-03-01T00:00:00Z"), to: new Date("2026-04-01T00:00:00Z") },
      { fetchImpl: impl }
    );
    check("no events come back when the ctag is unchanged and the window is covered", result.icsDocuments.length === 0);
    check(
      "only ONE request was made — no doomed sync-collection REPORT, no query",
      calls.length === 1 && calls[0]?.method === "PROPFIND",
      JSON.stringify(calls.map((c) => c.method))
    );
    check(
      "the ctag cursor is returned unchanged (its ctag, at least — the probe timestamp refreshes)",
      /^ctag:\d+:99$/.test(result.nextSyncToken ?? ""),
      String(result.nextSyncToken)
    );
  }

  console.log("\na widened window is not covered by the stored one — the short-circuit does not fire");
  {
    // Same unchanged ctag as above, but the cursor's stored window is narrower than what is
    // being requested now (a rolling window moved forward). An event that only just entered
    // the window must not be invisible just because nothing ELSE about the calendar changed.
    const { impl, calls } = stubFetch([xml(CTAG_PROPFIND_RESPONSE), xml(CALENDAR_QUERY_RESPONSE)]);
    const result = await fetchChanges(
      CREDS,
      "https://caldav.icloud.com/1234567/calendars/no-sync/",
      { syncToken: ctagCursorFor("99"), windowStart: "2026-03-01T00:00:00Z", windowEnd: "2026-03-15T00:00:00Z" },
      { from: new Date("2026-03-01T00:00:00Z"), to: new Date("2026-04-01T00:00:00Z") }, // extends past windowEnd
      { fetchImpl: impl }
    );
    check("the query still runs despite the unchanged ctag", result.icsDocuments.length === 1, String(result.icsDocuments.length));
    check(
      "the probe is still skipped (known non-sync calendar) — PROPFIND then REPORT, not three calls",
      calls.length === 2 && calls[0]?.method === "PROPFIND" && calls[1]?.method === "REPORT",
      JSON.stringify(calls.map((c) => c.method))
    );
    check("the ctag cursor comes back prefixed", /^ctag:\d+:99$/.test(result.nextSyncToken ?? ""), String(result.nextSyncToken));
  }

  console.log("\na transient failure never permanently downgrades a sync-capable calendar");
  {
    // Represents the same class of failure a 429/5xx would (retried to exhaustion, then
    // thrown) without touching `recordErrorEvent` — see this file's header comment for why a
    // real 503 can't be used here.
    const { impl, calls } = stubFetch([networkFailure]);
    let threw: unknown = null;
    try {
      await fetchChanges(
        CREDS,
        "https://caldav.icloud.com/1234567/calendars/home/",
        { syncToken: "a-real-sync-token" },
        { from: new Date("2026-03-01T00:00:00Z"), to: new Date("2026-04-01T00:00:00Z") },
        { fetchImpl: impl }
      );
    } catch (err) {
      threw = err;
    }
    check("a sustained failure propagates rather than resolving to a fallback result", threw !== null, String(threw));
    check(
      "the retry ladder was spent on the SAME sync-collection REPORT — never fell back to a probe or query",
      calls.length === 3 && calls.every((c) => c.method === "REPORT"),
      JSON.stringify(calls.map((c) => c.method))
    );
  }

  console.log("\na stale sync-token resyncs instead of falling back (RFC 6578's valid-sync-token precondition)");
  {
    const { impl, calls } = stubFetch([staleSyncTokenRejected(), xml(SYNC_COLLECTION_RESPONSE)]);
    const result = await fetchChanges(
      CREDS,
      "https://caldav.icloud.com/1234567/calendars/home/",
      { syncToken: "an-expired-sync-token" },
      { from: new Date("2026-03-01T00:00:00Z"), to: new Date("2026-04-01T00:00:00Z") },
      { fetchImpl: impl }
    );
    check(
      "the resync succeeds instead of falling back to the ctag path",
      result.nextSyncToken === "https://caldav.icloud.com/1234567/calendars/home/sync/2",
      String(result.nextSyncToken)
    );
    check(
      "exactly two REPORT attempts were made — the first rejected as stale, the retry succeeded",
      calls.length === 2 && calls.every((c) => c.method === "REPORT"),
      JSON.stringify(calls.map((c) => c.method))
    );
    check("the first attempt sent the (now stale) stored token", calls[0]?.body?.includes("an-expired-sync-token") ?? false);
    check(
      "the retry sent an EMPTY sync-token, not the stale one — a full resync, per RFC 6578",
      (calls[1]?.body?.includes("<D:sync-token></D:sync-token>") ?? false) &&
        !(calls[1]?.body?.includes("an-expired-sync-token") ?? true),
      calls[1]?.body ?? ""
    );
  }
  {
    // A 403 with the SAME status as the precondition case, but without the precondition body
    // — must NOT be mistaken for "stale token, retry". This is exactly the "fallback to ctag"
    // check above (`forbidden()`'s body is empty), re-asserted here as the negative case this
    // ruling specifically has to get right: a bare 403 still falls back after one attempt,
    // not two.
    const { impl, calls } = stubFetch([forbidden(), xml(CTAG_PROPFIND_RESPONSE), xml(CALENDAR_QUERY_RESPONSE)]);
    await fetchChanges(
      CREDS,
      "https://caldav.icloud.com/1234567/calendars/home/",
      { syncToken: "a-real-sync-token" },
      { from: new Date("2026-03-01T00:00:00Z"), to: new Date("2026-04-01T00:00:00Z") },
      { fetchImpl: impl }
    );
    check(
      "a 403 with no valid-sync-token body falls back after ONE rejected attempt, not a retry",
      calls.length === 3 && calls[0]?.method === "REPORT" && calls[1]?.method === "PROPFIND",
      JSON.stringify(calls.map((c) => c.method))
    );
  }

  console.log("\na ctag cursor older than 7 days re-probes sync-collection support");
  {
    const EIGHT_DAYS_MS = 8 * 24 * 60 * 60 * 1000;
    const { impl, calls } = stubFetch([xml(SYNC_COLLECTION_RESPONSE)]);
    const result = await fetchChanges(
      CREDS,
      "https://caldav.icloud.com/1234567/calendars/home/",
      { syncToken: ctagCursorFor("99", EIGHT_DAYS_MS) }, // classified "unsupported" over a week ago
      { from: new Date("2026-03-01T00:00:00Z"), to: new Date("2026-04-01T00:00:00Z") },
      { fetchImpl: impl }
    );
    check(
      "the calendar re-probes and picks up real sync support instead of staying pinned to ctag forever",
      result.nextSyncToken === "https://caldav.icloud.com/1234567/calendars/home/sync/2",
      String(result.nextSyncToken)
    );
    check(
      "only one request was made — straight to sync-collection, not the ctag fallback",
      calls.length === 1 && calls[0]?.method === "REPORT",
      JSON.stringify(calls.map((c) => c.method))
    );
    check(
      "the re-probe sent an EMPTY token — a ctag cursor never carries a real sync-token to resume from",
      calls[0]?.body?.includes("<D:sync-token></D:sync-token>") ?? false,
      calls[0]?.body ?? ""
    );
  }
  {
    // The other side: a ctag cursor well within the TTL does NOT re-probe. Already covered by
    // "a known non-sync calendar (ctag-prefixed cursor) skips the probe entirely" above
    // (age 0), restated here at a realistic "a few hours old" age to make the boundary clear.
    const { impl, calls } = stubFetch([xml(CTAG_PROPFIND_RESPONSE)]);
    const result = await fetchChanges(
      CREDS,
      "https://caldav.icloud.com/1234567/calendars/no-sync/",
      {
        syncToken: ctagCursorFor("99", 6 * 60 * 60 * 1000), // 6 hours old, well under the 7-day TTL
        windowStart: "2026-01-01T00:00:00Z",
        windowEnd: "2026-06-01T00:00:00Z",
      },
      { from: new Date("2026-03-01T00:00:00Z"), to: new Date("2026-04-01T00:00:00Z") },
      { fetchImpl: impl }
    );
    check(
      "a fresh (6h old) ctag cursor does not re-probe",
      calls.length === 1 && calls[0]?.method === "PROPFIND",
      JSON.stringify(calls.map((c) => c.method))
    );
    check("no events come back — nothing changed and the classification is still trusted", result.icsDocuments.length === 0);
  }

  console.log("\nCalDavRejectedError and CalDavStaleSyncTokenError are exported, so callers outside fetchChanges can catch them");
  {
    // discoverPrincipal/listCalendars have no fallback logic of their own — before these were
    // exported, a 4xx from either reached a caller as a plain Error with no `code` to switch
    // on. Same detection path in `davRequest` regardless of which public function called it.
    const { impl } = stubFetch([forbidden()]);
    await refuses(
      "a definitive 4xx from listCalendars raises the exported CalDavRejectedError",
      () => listCalendars(CREDS, "https://caldav.icloud.com/1234567/calendars/", { fetchImpl: impl }),
      (err) => err instanceof CalDavRejectedError && err.status === 403
    );
  }
  {
    const { impl } = stubFetch([staleSyncTokenRejected()]);
    await refuses(
      "a valid-sync-token precondition from listCalendars raises the exported CalDavStaleSyncTokenError",
      () => listCalendars(CREDS, "https://caldav.icloud.com/1234567/calendars/", { fetchImpl: impl }),
      (err) => err instanceof CalDavStaleSyncTokenError
    );
  }

  console.log("\nan oversized response raises rather than silently truncating");
  {
    const { impl } = stubFetch([oversizedPropfindResponse()]);
    await refuses(
      "a response over the byte cap is refused, not truncated into a partial result",
      () => listCalendars(CREDS, "https://caldav.icloud.com/1234567/calendars/", { fetchImpl: impl }),
      (err) => err instanceof EventPageError && err.code === "too_large"
    );
  }

  console.log("\nhost pinning");
  {
    const { impl, calls } = stubFetch([xml(CALENDAR_LIST_PROPFIND_RESPONSE)]);
    await refuses(
      "a non-Apple host is refused",
      () => listCalendars(CREDS, "https://evil.example.com/calendars/", { fetchImpl: impl }),
      (err) => err instanceof Error && err.message.includes("outside icloud.com")
    );
    check("the non-Apple host was never actually contacted", calls.length === 0, String(calls.length));
  }
  {
    // The credential-leak path: caldav.icloud.com answers the FIRST request with a redirect
    // to an attacker-controlled host. If the client followed it (as a plain `fetch` with
    // `redirect: "follow"` would), the Authorization header goes there instead.
    //
    // An IP literal, not a domain name: `assertDeliverable` (the generic SSRF guard this
    // request also passes through) resolves a domain name via real DNS before our own
    // Apple-only pin ever runs, which would make this check's speed depend on the sandbox's
    // DNS reachability. A bare public IP skips that lookup entirely (see `net-guard.ts`),
    // so this fails fast on our host pin specifically, not on network conditions.
    const { impl, calls } = stubFetch([redirect("https://93.184.216.34/steal-the-password")]);
    await refuses("a redirect to a non-Apple host is refused rather than followed", () =>
      discoverPrincipal(CREDS, { fetchImpl: impl })
    );
    check(
      "only the first hop was ever attempted — the redirect target was never fetched",
      calls.length === 1 && calls[0]?.url === "https://caldav.icloud.com/",
      JSON.stringify(calls.map((c) => c.url))
    );
  }
  {
    // The other side of the pin: Apple genuinely does redirect requests to per-account shard
    // hosts (`p42-caldav.icloud.com` and the like). A pin that over-refuses — blocking those
    // too — would look identical to a correct one in every check above; this is the one that
    // catches it. `listCalendars` rather than `discoverPrincipal` here: one request, one
    // redirect, no second round-trip to stub a response for.
    const { impl, calls } = stubFetch([
      redirect("https://p42-caldav.icloud.com/1234567/calendars/"),
      xml(CALENDAR_LIST_PROPFIND_RESPONSE),
    ]);
    const calendars = await listCalendars(CREDS, "https://caldav.icloud.com/1234567/calendars/", { fetchImpl: impl });
    check("a redirect to a *.icloud.com shard host is followed, not refused", calendars.length === 2, String(calendars.length));
    check("both hops were fetched", calls.length === 2, String(calls.length));
    check(
      "the second hop went to the shard host",
      calls[1]?.url === "https://p42-caldav.icloud.com/1234567/calendars/",
      calls[1]?.url
    );
    check(
      "the credential reached the shard host too, only after its own host check passed",
      calls[1]?.headers["authorization"] === `Basic ${Buffer.from(`${CREDS.username}:${CREDS.password}`).toString("base64")}`
    );
    check(
      "the returned calendar URLs resolve against the shard host, not the original request URL",
      calendars.every((c) => c.url.startsWith("https://p42-caldav.icloud.com/")),
      calendars.map((c) => c.url).join(", ")
    );
  }

  if (failures > 0) {
    console.error(`\n${failures} check(s) failed.`);
    process.exit(1);
  }
  console.log("\nAll CalDAV client checks passed.");
}

main();
