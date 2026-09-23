/**
 * The CalDAV transport layer: discovery, calendar listing, and change fetching.
 *
 * Pure tier: `client.ts` issues no database statement — it only talks to `guardedFetchText`,
 * which is given a stubbed `fetchImpl` here, so nothing in this file touches a database or a
 * real network.
 *
 * The fixtures driving these checks are synthetic (see `src/lib/caldav/fixtures/index.ts`) —
 * Task 1's real-Apple spike has not run yet. What matters most here is not "does the XML
 * parse" but the properties this client exists to enforce: the password reaches
 * caldav.icloud.com (and its shard hosts) and nowhere else, even across a redirect; a 401
 * comes back as a distinct signal; a transient failure never gets confused with "this
 * calendar doesn't support X"; and a cursor is never advanced past data the client never
 * actually saw.
 */
import {
  CalDavAuthError,
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

function serviceUnavailable() {
  return new Response("", { status: 503, headers: { "content-type": "text/plain" } });
}

function redirect(to: string) {
  return new Response(null, { status: 302, headers: { location: to } });
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
      "the new ctag is returned prefixed, so the NEXT call knows to skip the probe",
      result.nextSyncToken === "ctag:99",
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
        syncToken: "ctag:99", // already known: this calendar does not support sync-collection
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
    check("the ctag cursor is returned unchanged, still prefixed", result.nextSyncToken === "ctag:99", String(result.nextSyncToken));
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
      { syncToken: "ctag:99", windowStart: "2026-03-01T00:00:00Z", windowEnd: "2026-03-15T00:00:00Z" },
      { from: new Date("2026-03-01T00:00:00Z"), to: new Date("2026-04-01T00:00:00Z") }, // extends past windowEnd
      { fetchImpl: impl }
    );
    check("the query still runs despite the unchanged ctag", result.icsDocuments.length === 1, String(result.icsDocuments.length));
    check(
      "the probe is still skipped (known non-sync calendar) — PROPFIND then REPORT, not three calls",
      calls.length === 2 && calls[0]?.method === "PROPFIND" && calls[1]?.method === "REPORT",
      JSON.stringify(calls.map((c) => c.method))
    );
    check("the ctag cursor comes back prefixed", result.nextSyncToken === "ctag:99", String(result.nextSyncToken));
  }

  console.log("\na transient failure never permanently downgrades a sync-capable calendar");
  {
    // A 503, not a 4xx: `guardedFetchText` classifies 429/5xx as retryable and burns its own
    // retry ladder before giving up — this must propagate as a real failure, not silently
    // become "this calendar must not support sync-collection".
    const { impl, calls } = stubFetch([serviceUnavailable()]);
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
    check("a 503 propagates as a failure rather than resolving to a fallback result", threw !== null, String(threw));
    check(
      "the retry ladder was spent on the SAME sync-collection REPORT — never fell back to a probe or query",
      calls.length === 3 && calls.every((c) => c.method === "REPORT"),
      JSON.stringify(calls.map((c) => c.method))
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
