/**
 * The conditional GET in front of a 10 MB feed, with no network and no database.
 *
 * Three properties, and each one is a way the hourly run goes wrong silently:
 *
 *   A 304 IS AN ANSWER, NOT A BROKEN REDIRECT. 304 sits in the 3xx range and carries no
 *   `Location`, so the redirect branch reported it as "the page redirected to nowhere" —
 *   which is what a conditional GET would have got for its trouble on every single run where
 *   nothing had changed. That is the steady state, so it would have been the normal case.
 *
 *   A BODY OVER BUDGET FAILS LOUDLY. The default is to truncate, which is right for an HTML
 *   page and catastrophic here: a truncated JSON document surfaces as a `JSON.parse` column
 *   number, and if it happened to parse it would read as "the feed shrank" and advance the
 *   cursor past listings nobody ever saw.
 *
 *   THE VALIDATORS ACTUALLY GET SENT. An `If-None-Match` that never leaves means every run
 *   downloads the whole file.
 *
 * `pure` tier: `feed-fetch.ts` reaches `net-guard.ts` and nothing else. It writes no rows
 * even on failure — that is the sweep's job — which is exactly what makes this testable here.
 *
 * Run: npx tsx scripts/smoke-job-feed-fetch.ts
 */
import {
  FEED_CONTENT_TYPES,
  FEED_TIMEOUT_MS,
  fetchFeedDocument,
  parseFeedDocument,
} from "../src/lib/jobs/feed-fetch";
import { MAX_FEED_BYTES } from "../src/lib/jobs/feed-sources";

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

const URL_UNDER_TEST = "https://example.com/listings.json";

type Call = { url: string; init: RequestInit };

/** A fetch that answers from a script and records what it was asked. */
function scriptedFetch(responses: Response[]) {
  const calls: Call[] = [];
  let i = 0;
  const fn = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    const res = responses[i++];
    if (!res) throw new Error("no scripted response left");
    return res;
  }) as unknown as typeof fetch;
  return { deps: { fetch: fn }, calls };
}

function jsonResponse(body: string, headers: Record<string, string> = {}) {
  return new Response(body, {
    status: 200,
    headers: { "content-type": "application/json", ...headers },
  });
}

function headerOf(call: Call, name: string): string | undefined {
  const headers = (call.init.headers ?? {}) as Record<string, string>;
  const hit = Object.entries(headers).find(([k]) => k.toLowerCase() === name);
  return hit?.[1];
}

async function main() {
  console.log("\na 304 is the steady state, not a failure");
  {
    const { deps } = scriptedFetch([new Response(null, { status: 304 })]);
    const out = await fetchFeedDocument({ url: URL_UNDER_TEST, etag: 'W/"abc"', deps });
    check("304 comes back as not_modified", out.kind === "not_modified", out.kind);
  }

  console.log("\nthe validators are actually sent");
  {
    const { deps, calls } = scriptedFetch([new Response(null, { status: 304 })]);
    await fetchFeedDocument({
      url: URL_UNDER_TEST,
      etag: 'W/"abc"',
      lastModified: "Wed, 10 Sep 2026 12:00:00 GMT",
      deps,
    });
    check("If-None-Match carries the stored etag", headerOf(calls[0]!, "if-none-match") === 'W/"abc"', String(headerOf(calls[0]!, "if-none-match")));
    // Not redundant with the ETag: a CDN that has dropped the entity tag can still answer
    // the date.
    check("  and If-Modified-Since the stored date", headerOf(calls[0]!, "if-modified-since") === "Wed, 10 Sep 2026 12:00:00 GMT");
  }
  {
    const { deps, calls } = scriptedFetch([jsonResponse("[]")]);
    await fetchFeedDocument({ url: URL_UNDER_TEST, deps });
    check("a first run sends no validators", headerOf(calls[0]!, "if-none-match") === undefined && headerOf(calls[0]!, "if-modified-since") === undefined);
  }
  {
    // The module's own promise about itself. A caller header must never be able to take the
    // agent string off a request this code makes on somebody else's infrastructure.
    const { deps, calls } = scriptedFetch([jsonResponse("[]")]);
    await fetchFeedDocument({ url: URL_UNDER_TEST, etag: "x", deps });
    check("the user agent identifies Orbit", (headerOf(calls[0]!, "user-agent") ?? "").startsWith("OrbitBot/"), String(headerOf(calls[0]!, "user-agent")));
  }

  console.log("\na 200 hands back the body and the next run's validators");
  {
    const { deps } = scriptedFetch([
      jsonResponse('[{"id":"a"}]', { etag: 'W/"next"', "last-modified": "Thu, 11 Sep 2026 09:00:00 GMT" }),
    ]);
    const out = await fetchFeedDocument({ url: URL_UNDER_TEST, deps });
    check("kind is ok", out.kind === "ok", out.kind);
    if (out.kind === "ok") {
      check("  the body comes through whole", out.text === '[{"id":"a"}]', out.text);
      check("  the new etag is carried out", out.etag === 'W/"next"', String(out.etag));
      check("  and the new last-modified", out.lastModified === "Thu, 11 Sep 2026 09:00:00 GMT");
      check("  bytes is the body actually read", out.bytes === '[{"id":"a"}]'.length, String(out.bytes));
    }
  }
  {
    // GitHub serves .json as text/plain. If that is ever rejected the feature stops dead.
    const { deps } = scriptedFetch([new Response("[]", { status: 200, headers: { "content-type": "text/plain; charset=utf-8" } })]);
    const out = await fetchFeedDocument({ url: URL_UNDER_TEST, deps });
    check("text/plain is accepted — raw.githubusercontent.com serves JSON as that", out.kind === "ok", out.kind);
    check("  and the allow-list says so", FEED_CONTENT_TYPES.includes("text/plain"));
  }

  console.log("\noversize fails loudly instead of truncating");
  {
    const body = "x".repeat(5_000);
    const { deps } = scriptedFetch([jsonResponse(body)]);
    const out = await fetchFeedDocument({ url: URL_UNDER_TEST, deps, maxBytes: 1_000 });
    check("over budget is a failure, not a short string", out.kind === "failed", out.kind);
    if (out.kind === "failed") {
      // Distinguished from a network problem on purpose: "the file grew" and "GitHub is
      // down" call for completely different responses, and only one of them is ours.
      check("  reported as too_large", out.status === "too_large", out.status);
    }
  }
  {
    const body = "x".repeat(500);
    const { deps } = scriptedFetch([jsonResponse(body)]);
    const out = await fetchFeedDocument({ url: URL_UNDER_TEST, deps, maxBytes: 1_000 });
    check("a body inside the budget is untouched", out.kind === "ok" && out.text.length === 500);
  }

  console.log("\nan error page is drift, never data");
  {
    // The case this guards: an HTML error page or a login wall handed to JSON.parse, and
    // reported as malformed listings rather than as "we are not reading the feed at all".
    const { deps } = scriptedFetch([new Response("<html>404</html>", { status: 200, headers: { "content-type": "text/html" } })]);
    const out = await fetchFeedDocument({ url: URL_UNDER_TEST, deps });
    check("HTML is refused", out.kind === "failed", out.kind);
    if (out.kind === "failed") check("  as schema_drift", out.status === "schema_drift", out.status);
  }
  {
    const { deps } = scriptedFetch([new Response(null, { status: 404 })]);
    const out = await fetchFeedDocument({ url: URL_UNDER_TEST, deps });
    check("a 404 is http_error", out.kind === "failed" && out.status === "http_error");
  }
  {
    // A branch rename is the likeliest real failure: `main` 404s and only `dev` has the file.
    const { deps } = scriptedFetch([new Response(null, { status: 404 })]);
    const out = await fetchFeedDocument({ url: URL_UNDER_TEST, deps });
    check("  and never throws", out.kind === "failed");
  }

  console.log("\nthe refusals that come from the SSRF guard, not the server");
  {
    // No scripted response at all: the guard must refuse before any request is made.
    const { deps, calls } = scriptedFetch([]);
    const out = await fetchFeedDocument({ url: "http://example.com/listings.json", deps });
    check("http:// is refused", out.kind === "failed", out.kind);
    check("  before a request is issued", calls.length === 0, String(calls.length));
  }
  {
    const { deps, calls } = scriptedFetch([]);
    const out = await fetchFeedDocument({ url: "https://169.254.169.254/listings.json", deps });
    check("the cloud metadata address is refused", out.kind === "failed");
    check("  before a request is issued", calls.length === 0);
  }

  console.log("\nparsing the document");
  {
    const ok = parseFeedDocument('[{"id":"a"}]');
    check("valid JSON parses", "doc" in ok && Array.isArray(ok.doc));
    const bad = parseFeedDocument('[{"id":');
    check("truncated JSON is an error, not a throw", "error" in bad, JSON.stringify(bad));
  }

  console.log("\nthe constants the budget depends on");
  check("the size cap is 24 MB — room over the feed's ~10 MB, under the function's memory", MAX_FEED_BYTES === 24 * 1024 * 1024, String(MAX_FEED_BYTES));
  // 8s (the page default) aborts a 10 MB download mid-body on any cold connection, and the
  // route's ceiling is 300s.
  check("the timeout suits a multi-megabyte body", FEED_TIMEOUT_MS >= 30_000 && FEED_TIMEOUT_MS <= 120_000, String(FEED_TIMEOUT_MS));

  console.log(failures === 0 ? "\nAll job feed fetch checks passed." : `\n${failures} check(s) failed.`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
