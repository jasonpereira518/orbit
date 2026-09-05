/**
 * The SSRF fence around fetching a user-supplied event page.
 *
 * This is the highest-severity code in the events feature: it makes Orbit issue a request to
 * an address a user chose. The existing webhook sender never follows redirects, so the
 * per-hop re-check below is genuinely NEW behaviour and the property most worth pinning —
 * a guard that only checks the entry URL is defeated by a 302.
 *
 * `pure` tier: `fetch-page.ts` reaches `net-guard.ts`, not `webhooks/dispatch.ts`, so nothing
 * here touches a database. That separation is exactly why the guard was extracted.
 */
import {
  ALLOWED_CONTENT_TYPES,
  EventPageError,
  MAX_HTML_BYTES,
  MAX_REDIRECT_HOPS,
  fetchEventPage,
} from "../src/lib/events/fetch-page";
import { assertDeliverable, isBlockedAddress } from "../src/lib/net-guard";

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

async function refuses(label: string, fn: () => Promise<unknown>, codeOrText?: string) {
  try {
    await fn();
    check(label, false, "it was ALLOWED");
  } catch (error) {
    const code = error instanceof EventPageError ? error.code : "";
    const message = error instanceof Error ? error.message : String(error);
    check(label, codeOrText ? code === codeOrText || message.includes(codeOrText) : true, code || message);
  }
}

/** A fetch that answers from a script, so no real network is touched. */
function scriptedFetch(steps: Array<Response | (() => Response)>) {
  let i = 0;
  const seen: string[] = [];
  const fn = (async (url: string | URL) => {
    seen.push(String(url));
    const step = steps[Math.min(i, steps.length - 1)];
    i++;
    return typeof step === "function" ? step() : step;
  }) as unknown as typeof fetch;
  return { fetch: fn, seen };
}

function html(body: string, headers: Record<string, string> = {}) {
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/html; charset=utf-8", ...headers },
  });
}

function redirect(to: string) {
  return new Response(null, { status: 302, headers: { location: to } });
}

async function main() {
  console.log("\naddress classification");
  const blocked: Array<[string, string]> = [
    ["127.0.0.1", "loopback"],
    ["0.0.0.0", "this network"],
    ["10.1.2.3", "RFC1918 /8"],
    ["172.16.0.1", "RFC1918 /12 lower"],
    ["172.31.255.254", "RFC1918 /12 upper"],
    ["192.168.1.1", "RFC1918 /16"],
    ["169.254.169.254", "cloud metadata"],
    ["100.64.0.1", "CGNAT"],
    ["224.0.0.1", "multicast"],
    ["::1", "IPv6 loopback"],
    ["fd00::1", "IPv6 unique local"],
    ["fe80::1", "IPv6 link local"],
    ["::ffff:169.254.169.254", "IPv4-mapped metadata"],
    ["::ffff:127.0.0.1", "IPv4-mapped loopback"],
    ["not-an-ip", "unparseable"],
  ];
  for (const [ip, why] of blocked) check(`blocks ${why} (${ip})`, isBlockedAddress(ip));
  check("allows a public IPv4", !isBlockedAddress("93.184.216.34"));
  check("allows a public IPv6", !isBlockedAddress("2606:2800:220:1:248:1893:25c8:1946"));

  console.log("\nURL-level refusals");
  await refuses("refuses http://", () => assertDeliverable("http://example.com"), "https");
  await refuses("refuses credentials in the URL", () =>
    assertDeliverable("https://user:pw@example.com")
  );
  await refuses("refuses localhost", () => assertDeliverable("https://localhost/x"));
  await refuses("refuses a .internal hostname", () =>
    assertDeliverable("https://db.internal/x")
  );
  await refuses("refuses a bare private IP host", () =>
    assertDeliverable("https://10.0.0.1/x")
  );
  await refuses("refuses the metadata IP as a host", () =>
    assertDeliverable("https://169.254.169.254/latest/meta-data/")
  );

  console.log("\nfetching");
  await refuses(
    "refuses a non-URL",
    () => fetchEventPage("not a url", scriptedFetch([html("")])),
    "blocked"
  );
  await refuses(
    "refuses an internal entry URL before any request",
    () => fetchEventPage("https://127.0.0.1/evt", scriptedFetch([html("")])),
    "blocked"
  );

  {
    // THE case this whole module exists for. `fetch` is called with redirect:"manual", so the
    // hop is ours to follow — and following it without re-checking is how a public URL
    // becomes a request to the metadata endpoint.
    const scripted = scriptedFetch([redirect("https://169.254.169.254/latest/meta-data/")]);
    await refuses(
      "refuses a redirect that lands on an internal address",
      () => fetchEventPage("https://example.com/evt", scripted),
      "blocked"
    );
    check(
      "and never requested the internal address",
      !scripted.seen.some((u) => u.includes("169.254.169.254")),
      scripted.seen.join(" -> ")
    );
  }

  {
    const scripted = scriptedFetch([redirect("https://example.com/a")]);
    await refuses(
      "refuses a redirect chain longer than the hop cap",
      () => fetchEventPage("https://example.com/evt", scripted),
      "too_many_redirects"
    );
    check(
      `stops after ${MAX_REDIRECT_HOPS} hops`,
      scripted.seen.length === MAX_REDIRECT_HOPS + 1,
      `${scripted.seen.length} requests`
    );
  }

  await refuses(
    "refuses a non-HTML content type",
    () =>
      fetchEventPage(
        "https://example.com/evt",
        scriptedFetch([new Response("{}", { status: 200, headers: { "content-type": "application/json" } })])
      ),
    "not_html"
  );
  check(
    "the allowed content types are HTML only",
    ALLOWED_CONTENT_TYPES.every((t) => t.includes("html") || t.includes("xhtml")),
    ALLOWED_CONTENT_TYPES.join(", ")
  );

  await refuses(
    "surfaces a 404 rather than pretending",
    () => fetchEventPage("https://example.com/evt", scriptedFetch([new Response(null, { status: 404 })])),
    "http_error"
  );

  {
    // Content-Length is optional and can lie, so the cap has to hold on the stream itself.
    const huge = "<html><head><title>Big</title></head><body>" + "x".repeat(MAX_HTML_BYTES * 2);
    const details = await fetchEventPage(
      "https://example.com/evt",
      scriptedFetch([html(huge, { "content-length": "10" })])
    );
    check("an oversized body is truncated, not swallowed", details.title === "Big", String(details.title));
  }

  {
    // A legitimate redirect — lu.ma short links do this — must still work.
    const scripted = scriptedFetch([
      redirect("https://lu.ma/real-event"),
      html('<html><head><title>Real</title><meta property="og:title" content="Real Event"></head></html>'),
    ]);
    const details = await fetchEventPage("https://lu.ma/abc", scripted);
    check("a normal redirect is followed", details.title === "Real Event", String(details.title));
    check("and the final URL is recorded", details.sourceUrl.endsWith("/real-event"), details.sourceUrl);
  }

  if (failures > 0) {
    console.error(`\n${failures} check(s) failed.`);
    process.exit(1);
  }
  console.log("\nAll event URL guard checks passed.");
}

void main();
