/**
 * The page reader behind paste-a-URL capture (`src/lib/web/read-page.ts`).
 *
 * What it pins: a denied host (LinkedIn above all) is never requested, not even when a short
 * link redirects there; http is upgraded; and the page comes back as bounded, readable text
 * with a `thin` flag for a browser-only page. The SSRF fence itself is
 * `smoke-event-url-guard.ts`'s job; one case here proves the reader still goes through it.
 *
 * `pure` tier: the fetch is scripted, so no page is ever requested.
 */
import { EventPageError } from "../src/lib/events/guarded-fetch";
import { MAX_PAGE_TEXT, THIN_TEXT_CHARS, isDeniedHost, readWebPage, visibleText } from "../src/lib/web/read-page";

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

async function refuses(label: string, fn: () => Promise<unknown>, text: string) {
  try {
    await fn();
    check(label, false, "it was ALLOWED");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    check(label, error instanceof EventPageError && message.includes(text), message);
  }
}

function scriptedFetch(steps: Response[]) {
  let i = 0;
  const seen: string[] = [];
  const fn = (async (url: string | URL) => {
    seen.push(String(url));
    return steps[Math.min(i++, steps.length - 1)]!;
  }) as unknown as typeof fetch;
  return { fetch: fn, seen };
}

const html = (body: string) =>
  new Response(body, { status: 200, headers: { "content-type": "text/html; charset=utf-8" } });
const redirect = (to: string) => new Response(null, { status: 302, headers: { location: to } });

const BIO = "Ada Lovelace is a professor of computing at Example University. ".repeat(6);

async function main() {
  console.log("\nhosts Orbit never reads");
  for (const url of ["https://www.linkedin.com/in/ada", "https://linkedin.com/company/x", "https://lnkd.in/abc"]) {
    const scripted = scriptedFetch([html("<p>nope</p>")]);
    await refuses(`refuses ${url}`, () => readWebPage(url, scripted), "LinkedIn");
    check(`  and never requests it`, scripted.seen.length === 0, scripted.seen.join(", "));
  }
  {
    const scripted = scriptedFetch([html("<p>nope</p>")]);
    await refuses("refuses lu.ma (events E0)", () => readWebPage("https://lu.ma/abc", scripted), "lu.ma");
    check("  and never requests it", scripted.seen.length === 0, scripted.seen.join(", "));
  }
  {
    // THE case: a short link that lands on LinkedIn. Refusing after the fact would already
    // have sent Orbit's request to LinkedIn.
    const scripted = scriptedFetch([redirect("https://www.linkedin.com/in/ada"), html("<p>profile</p>")]);
    await refuses("refuses a redirect that lands on LinkedIn", () => readWebPage("https://example.com/s", scripted), "LinkedIn");
    check(
      "  and the LinkedIn URL is never requested",
      scripted.seen.length === 1 && scripted.seen[0] === "https://example.com/s",
      scripted.seen.join(", ")
    );
  }
  check("a look-alike host is not denied", !isDeniedHost("notlinkedin.com"));
  check("a subdomain of a denied host is", isDeniedHost("uk.linkedin.com"));

  console.log("\nthe link itself");
  {
    const scripted = scriptedFetch([html(`<p>${BIO}</p>`)]);
    await readWebPage("http://example.com/~ada#bio", scripted);
    check("http is upgraded and the fragment dropped", scripted.seen[0] === "https://example.com/~ada", scripted.seen[0]);
  }
  await refuses("refuses a non-web scheme", () => readWebPage("ftp://example.com/x", scriptedFetch([html("")])), "https://");
  await refuses("refuses something that is not a link", () => readWebPage("ada lovelace", scriptedFetch([html("")])), "web link");
  await refuses(
    "still goes through the SSRF fence",
    () => readWebPage("https://example.com/s", scriptedFetch([redirect("https://169.254.169.254/latest/meta-data/")])),
    ""
  );

  console.log("\nwhat comes back");
  {
    const page = await readWebPage(
      "https://example.com/team",
      scriptedFetch([
        html(`<html><head><title>Ignored</title><meta property="og:title" content="Our team &amp; friends">
          <meta name="description" content="Who we are">
          <script type="application/ld+json">{"@type":"Person","name":"Ada Lovelace","jobTitle":"Professor"}</script>
          <style>.x{color:red}</style></head>
          <body><h1>Team</h1><div>Ada Lovelace<br>Professor</div><script>steal()</script>
          <p>Grace Hopper &mdash; Rear Admiral</p><p>${BIO}</p></body></html>`),
      ])
    );
    check("og:title wins, entities decoded", page.title === "Our team & friends", String(page.title));
    check("description read", page.description === "Who we are", String(page.description));
    check(
      "JSON-LD Person parsed",
      page.jsonLd.some((n) => n.name === "Ada Lovelace" && n.jobTitle === "Professor"),
      JSON.stringify(page.jsonLd)
    );
    check("scripts and styles are not text", !page.text.includes("steal") && !page.text.includes("color:red"), page.text.slice(0, 80));
    check("blocks stay on their own lines", page.text.startsWith("Team\nAda Lovelace\nProfessor\n"), JSON.stringify(page.text.slice(0, 60)));
    check("named entities decoded", page.text.includes("Grace Hopper — Rear Admiral"), page.text.slice(0, 120));
    check("a real page is not thin", !page.thin, String(page.text.length));
  }
  {
    const shell = `<html><body><div id="root"></div>
      <noscript>You need to enable JavaScript to run this app.</noscript></body></html>`;
    const page = await readWebPage("https://example.com/app", scriptedFetch([html(shell)]));
    check("a JavaScript shell is thin", page.thin && page.text.length < THIN_TEXT_CHARS, JSON.stringify(page.text));
  }
  check(
    "text is capped",
    visibleText(`<p>${"word ".repeat(MAX_PAGE_TEXT)}</p>`).length === MAX_PAGE_TEXT
  );

  if (failures > 0) {
    console.error(`\n${failures} check(s) failed.`);
    process.exit(1);
  }
  console.log("\nAll web page reader checks passed.");
}

void main();
