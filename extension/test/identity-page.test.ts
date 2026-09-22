import { describe, expect, it } from "vitest";
import { IDENTITY_ONLY, identityOnlyPage, profileFromLink } from "@/lib/identity-page";

describe("profileFromLink", () => {
  it.each([
    ["https://de.linkedin.com/in/Amara-Osei/?trk=x", "linkedin", "https://www.linkedin.com/in/amara-osei"],
    ["https://twitter.com/AmaraOsei", "x", "https://x.com/amaraosei"],
    ["https://github.com/AmaraOsei", "github", "https://github.com/amaraosei"],
  ])("%s is a %s profile", (href, site, url) => {
    expect(profileFromLink(href)).toMatchObject({ site, url });
  });

  it.each([
    "https://github.com/amaraosei/orbit", // a repo, not its owner's profile
    "https://help.x.com/en/using-x", // the X help centre, not a handle
    "https://x.com/home",
    "https://example.com/in/amara-osei",
    "not a url",
  ])("%s is not a profile", (href) => {
    expect(profileFromLink(href)).toBeNull();
  });
});

describe("identityOnlyPage", () => {
  it("builds a resolvable page from a list row, with no page text", () => {
    const page = identityOnlyPage({
      name: "Amara Osei",
      profileUrl: "https://www.linkedin.com/in/amara-osei",
      subtitle: "VP Engineering at Stripe",
    })!;
    expect(page.site).toBe("linkedin");
    expect(page.kind).toBe("person");
    expect(page.identity.handle?.value).toBe("amara-osei");
    expect(page.identity.name?.value).toBe("Amara Osei");
    expect(page.text.blob).toBe("");
    expect(page.warnings).toContain(IDENTITY_ONLY);
  });

  it("an address alone is enough (Gmail threads)", () => {
    const page = identityOnlyPage({ name: "Ben Tate", email: "ben@tidepool.io" })!;
    expect(page.identity.email?.value).toBe("ben@tidepool.io");
  });

  it("a name alone is not an identity", () => {
    expect(identityOnlyPage({ name: "Ben Tate" })).toBeNull();
  });
});
