// @vitest-environment happy-dom
/**
 * The page readers, against synthetic pages shaped like the real ones.
 *
 * Honest limit: these pages are written from knowledge of each site's markup,
 * not captured from it — which is exactly how the reverted LinkedIn
 * work-history readers were tested. What they DO pin is the logic around the
 * selectors: that a team page is a list and not its first member, that a repo
 * isn't a person, that a thread's addresses are identities. Replace them with
 * real fixtures from the fixture saver as those are captured.
 */
import { describe, expect, it } from "vitest";
import { adapterFor } from "@/inject/adapters/registry";

function read(url: string, html: string) {
  (window as unknown as { happyDOM: { setURL(u: string): void } }).happyDOM.setURL(url);
  document.documentElement.innerHTML = new DOMParser()
    .parseFromString(html, "text/html")
    .documentElement.innerHTML;
  const parsed = new URL(url);
  return adapterFor(parsed).extract(parsed);
}

describe("GitHub", () => {
  const profile = `<head>
    <meta name="hovercard-subject-tag" content="user:123">
    <meta property="og:title" content="amaraosei (Amara Osei) · GitHub">
  </head><body><main>
    <div itemscope itemtype="http://schema.org/Person">
      <img class="avatar avatar-user" src="https://avatars.githubusercontent.com/u/123">
      <span itemprop="name">Amara Osei</span>
      <div data-bio-text>Payments infrastructure. Previously Acme.</div>
      <span itemprop="worksFor">@stripe</span>
      <span itemprop="homeLocation">San Francisco</span>
      <ul>
        <li itemprop="social"><a href="https://www.linkedin.com/in/amara-osei/">in/amara-osei</a></li>
        <li itemprop="social"><a href="https://x.com/amaraosei">@amaraosei</a></li>
      </ul>
    </div></main></body>`;

  it("reads a person's profile", () => {
    const page = read("https://github.com/AmaraOsei", profile);
    expect(page.site).toBe("github");
    expect(page.kind).toBe("person");
    expect(page.url).toBe("https://github.com/amaraosei");
    expect(page.identity.name?.value).toBe("Amara Osei");
    expect(page.identity.handle?.value).toBe("amaraosei");
    expect(page.identity.company?.value).toBe("stripe");
    expect(page.identity.location?.value).toBe("San Francisco");
  });

  it("carries the other profiles its sidebar links to — exact keys", () => {
    const links = read("https://github.com/amaraosei", profile).identity.links;
    expect(links?.linkedin).toBe("https://www.linkedin.com/in/amara-osei");
    expect(links?.x).toBe("https://x.com/amaraosei");
    expect(links?.github).toBe("https://github.com/amaraosei");
  });

  it("reads an organization as a company, not a person", () => {
    const page = read(
      "https://github.com/anthropics",
      `<head><meta name="hovercard-subject-tag" content="organization:42"></head>
       <body><h1 itemprop="name">Anthropic</h1></body>`
    );
    expect(page.kind).toBe("company");
    expect(page.org).toEqual({ name: "Anthropic", githubLogin: "anthropics" });
    expect(page.identity.name).toBeNull();
  });

  it("a repository is about code, not a person", () => {
    expect(read("https://github.com/amaraosei/orbit", profile).kind).toBe("unknown");
  });

  it("GitHub's own pages are not people", () => {
    expect(read("https://github.com/settings", profile).kind).toBe("unknown");
  });
});

describe("LinkedIn company pages", () => {
  const company = `<head><meta property="og:title" content="Stripe | LinkedIn"></head>
    <body><main><h1>Stripe</h1></main></body>`;

  it("names the organization, with its LinkedIn slug", () => {
    const page = read("https://www.linkedin.com/company/stripe/", company);
    expect(page.kind).toBe("company");
    expect(page.org).toEqual({ name: "Stripe", linkedinSlug: "stripe" });
  });

  it("the People tab is a pick list of who's rendered", () => {
    const page = read(
      "https://www.linkedin.com/company/stripe/people/",
      `<head><meta property="og:title" content="Stripe | LinkedIn"></head><body><main><ul>
        <li><a href="https://www.linkedin.com/in/amara-osei/">Amara Osei</a></li>
        <li><a href="/in/ben-tate?miniProfileUrn=x">Ben Tate</a></li>
        <li><a href="https://www.linkedin.com/in/amara-osei/">Amara Osei</a></li>
      </ul></main></body>`
    );
    expect(page.org?.name).toBe("Stripe");
    expect(page.candidates?.map((c) => c.name)).toEqual(["Amara Osei", "Ben Tate"]);
    expect(page.candidates?.[1].profileUrl).toBe("https://www.linkedin.com/in/ben-tate");
  });
});

describe("generic pages", () => {
  it("a team page is a list — not its first member", () => {
    // The bug: the person logic took the first LinkedIn link on the page as
    // THE person, with high confidence, and called the page a profile.
    const page = read(
      "https://acme.dev/team",
      `<head><meta property="og:site_name" content="Acme"></head><body><main>
        <h1>Our team</h1>
        <a href="https://www.linkedin.com/in/amara-osei">Amara Osei</a>
        <a href="https://www.linkedin.com/in/ben-tate"><img alt="Ben Tate" src="b.jpg"></a>
        <a href="https://www.linkedin.com/in/chioma-eze" aria-label="Chioma Eze">in</a>
      </main></body>`
    );
    expect(page.kind).toBe("list");
    expect(page.candidates?.map((c) => c.name)).toEqual(["Amara Osei", "Ben Tate", "Chioma Eze"]);
    expect(page.org?.name).toBe("Acme");
    expect(page.identity.profileUrl).toBeNull();
  });

  it("a personal site linking its owner's LinkedIn is still a person", () => {
    const page = read(
      "https://amara.dev/about",
      `<head><script type="application/ld+json">{"@type":"Person","name":"Amara Osei"}</script></head>
       <body><main><h1>Amara Osei</h1>
         <a href="https://www.linkedin.com/in/amara-osei">LinkedIn</a>
         <a href="https://x.com/amaraosei">X</a>
       </main></body>`
    );
    expect(page.kind).toBe("person");
    expect(page.identity.links?.linkedin).toBe("https://www.linkedin.com/in/amara-osei");
    expect(page.identity.links?.x).toBe("https://x.com/amaraosei");
  });
});

describe("Gmail threads", () => {
  it("a multi-party thread's addresses are identities, and never more than ten", () => {
    const spans = Array.from(
      { length: 14 },
      (_, i) => `<span email="person${i}@example.com" name="Person Number${String.fromCharCode(65 + i)}"></span>`
    ).join("");
    const page = read("https://mail.google.com/mail/u/0/#inbox/abc", `<body>${spans}</body>`);
    expect(page.candidates?.length).toBe(10);
    expect(page.candidates?.[0].email).toBe("person0@example.com");
  });
});
