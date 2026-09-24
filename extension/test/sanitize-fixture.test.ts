// @vitest-environment happy-dom
/**
 * The fixture sanitizer's two jobs, tested against each other: nothing real
 * survives, AND the page still reads the same way to the real adapter. A
 * sanitizer that passed only the first would produce fixtures that test
 * nothing; one that passed only the second would commit someone's profile.
 */
import { describe, expect, it } from "vitest";
import { sanitizeFixture } from "@/dev/sanitize-fixture";
import { adapterFor } from "@/inject/adapters/registry";

const REAL_URL =
  "https://www.linkedin.com/in/amara-osei/?miniProfileUrn=urn%3Ali%3Afs_miniProfile%3AACoAAB1234567890";

const LONG_ABOUT =
  "I lead payments infrastructure at Stripe. Before that I spent six years at Acme rebuilding their billing stack twice, which is a story for another day.";

/** A page shaped like a signed-in LinkedIn profile, full of things to leak. */
const REAL_PAGE = `<!doctype html><html><head>
<title>Amara Osei - VP Engineering at Stripe | LinkedIn</title>
<meta property="og:title" content="Amara Osei - VP Engineering at Stripe">
<meta property="og:image" content="https://media.licdn.com/dms/image/amara.jpg">
<meta name="tracking-id" content="abc123-session-token">
<link rel="stylesheet" href="https://static.licdn.com/sc/h/app.css">
<style>.x{color:red}</style>
<script>window.__tracking = { member: "ACoAAB1234567890" };</script>
<script type="application/ld+json">{"@type":"Person","name":"Amara Osei","sameAs":"https://www.linkedin.com/in/amara-osei","description":"${LONG_ABOUT}"}</script>
</head><body>
<!-- rendered for Amara Osei, session 99 -->
<main>
  <section class="top-card" data-view-tracking="t-1234" onclick="track()">
    <img src="https://media.licdn.com/dms/image/amara.jpg" alt="Amara Osei" width="200">
    <h1>Amara Osei</h1>
    <div class="text-body-medium">VP Engineering at Stripe</div>
    <span class="text-body-small">San Francisco Bay Area</span>
    <a href="mailto:amara.osei@stripe.com">amara.osei@stripe.com</a>
    <span>+1 (415) 555-2671</span>
    <span>Stripe · 2019 - 2024</span>
  </section>
  <section><h2>About</h2><p>${LONG_ABOUT}</p></section>
  <aside>
    <h2>People also viewed</h2>
    <a href="https://www.linkedin.com/in/ben-tate/?trk=pymk">Ben Tate</a>
    <a href="/in/chioma-eze">Chioma Eze</a>
    <button aria-label="Message Ben Tate">Message</button>
  </aside>
</main>
</body></html>`;

function sanitize(html = REAL_PAGE) {
  return sanitizeFixture(html, { url: REAL_URL, names: ["Amara Osei"] });
}

function load(html: string, url: string) {
  (window as unknown as { happyDOM: { setURL(u: string): void } }).happyDOM.setURL(url);
  document.documentElement.innerHTML = new DOMParser()
    .parseFromString(html, "text/html")
    .documentElement.innerHTML;
}

describe("sanitizeFixture — nothing real survives", () => {
  const result = sanitize();
  if (!result.ok) throw new Error(`refused: ${result.leaks.join(", ")}`);
  const out = result.html.toLowerCase();

  it.each([
    ["the subject's name", "amara"],
    ["the subject's surname", "osei"],
    ["the subject's slug", "amara-osei"],
    ["a third party from 'People also viewed'", "ben tate"],
    ["a third party linked by a relative href", "chioma"],
    ["the email", "amara.osei@stripe.com"],
    ["the phone number", "555-2671"],
    ["LinkedIn's internal member id", "acoaab1234567890"],
    ["a tracking query param", "trk=pymk"],
    ["a session token in a dropped meta tag", "abc123-session-token"],
    ["an HTML comment", "session 99"],
    ["inline tracking attributes", "data-view-tracking"],
    ["inline handlers", "onclick"],
  ])("drops %s", (_label, needle) => {
    expect(out).not.toContain(needle);
  });

  it("keeps only JSON-LD scripts, and no styles", () => {
    expect(out).not.toContain("window.__tracking");
    expect(out).not.toContain("<style");
    expect(out).toContain('type="application/ld+json"');
  });

  it("scrambles long prose but keeps its length", () => {
    expect(out).not.toContain("payments infrastructure");
    expect(result.report.proseBlocks).toBeGreaterThan(0);
  });

  it("does not mistake a date range for a phone number", () => {
    expect(result.html).toContain("2019 - 2024");
  });

  it("gives each person one consistent pseudonym, and different people different ones", () => {
    const subject = result.html.match(/Avery Quill/g) ?? [];
    expect(subject.length).toBeGreaterThan(2); // title, h1, alt, og, JSON-LD…
    expect(result.html).toContain("Blake Harrow");
    expect(result.html).toContain("Message Blake Harrow");
    expect(result.report.people).toBe(3);
  });

  it("maps the page's own URL to the subject's pseudonymous slug", () => {
    expect(result.url).toBe("https://www.linkedin.com/in/person-1/");
  });
});

describe("sanitizeFixture — the page still reads the same way", () => {
  it("the real LinkedIn adapter reads the sanitized page as the pseudonym", () => {
    const result = sanitize();
    if (!result.ok) throw new Error("refused");
    load(result.html, result.url);
    const page = adapterFor(new URL(result.url)).extract(new URL(result.url));

    expect(page.site).toBe("linkedin");
    expect(page.kind).toBe("person");
    expect(page.identity.name?.value).toBe("Avery Quill");
    expect(page.identity.handle?.value).toBe("person-1");
    expect(page.identity.headline?.value ?? page.identity.title?.value).toMatch(
      /VP Engineering/
    );
    expect(page.warnings).not.toContain("login-wall");
  });
});

describe("sanitizeFixture — refuses rather than trusts", () => {
  it("refuses to produce a file when a real value survives somewhere it doesn't rewrite", () => {
    // A class name carrying a profile slug: classes aren't rewritten (adapters
    // select on them), so the only thing standing between this and a commit is
    // the final leak check.
    const leaky = REAL_PAGE.replace(
      '<section class="top-card"',
      '<section class="top-card member-amara-osei"'
    );
    const result = sanitize(leaky);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.leaks.length).toBeGreaterThan(0);
      // It says WHAT KIND leaked, never the value — this goes on screen.
      expect(result.leaks.join(" ")).not.toMatch(/amara|osei/i);
    }
  });

  it("renames people whose names carry accents", () => {
    // `\b` is ASCII-only even with the `u` flag; this is the case it would miss.
    const html = REAL_PAGE.replaceAll("Chioma Eze", "Renée Dubé");
    const result = sanitize(html);
    if (!result.ok) throw new Error(`refused: ${result.leaks.join(", ")}`);
    expect(result.html).not.toMatch(/Renée|Dubé/);
  });
});
