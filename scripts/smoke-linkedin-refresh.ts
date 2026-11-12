/**
 * Smoke test for "Refresh contacts from LinkedIn" engine:
 * 1. Full profile HTML extraction (JSON-LD + OpenGraph + <title> + meta description)
 * 2. Contact enrichment without paid Apollo API key (role, company, school, location, avatar, name)
 * 3. 0ms cross-user shared database pooling (linkedin_avatars)
 * 4. Fallback to cached public_work_history when direct scrape is unavailable
 *
 * Run: npx tsx scripts/smoke-linkedin-refresh.ts
 */
import "./smoke/_env";

import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { getDb } from "../src/db";
import { contacts, linkedinAvatars } from "../src/db/schema";
import {
  extractLinkedInFullProfileFromHtml,
  splitFullName,
  splitHeadline,
  isLikelyPersonName,
} from "../src/lib/linkedin-scraper";
import {
  refreshContactsFromLinkedIn,
} from "../src/actions/contacts";
import { writePublicWorkHistory } from "../src/lib/public-work-history";
import { getSharedAvatar } from "../src/lib/shared-avatars";
import { checker } from "./smoke/check";

delete process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY;
delete process.env.CLERK_SECRET_KEY;
// Blob unconfigured, so a pooled photo keeps its raw https URL and no test ever writes to a
// developer's real bucket. Matches CI, where `.env.local` (and its Blob token) does not exist.
delete process.env.BLOB_READ_WRITE_TOKEN;
delete process.env.BLOB_STORE_ID;
delete process.env.VERCEL_OIDC_TOKEN;
(process.env as Record<string, string>).NODE_ENV = "development";
process.env.ORBIT_DEMO_DATA = "off";

const t = checker();
const TEST_USER = "demo-user";

async function main() {
  // --- Part 1: Unit tests for HTML profile extraction ---
  const sampleJsonLdHtml = `
    <!DOCTYPE html>
    <html>
      <head>
        <title>Satya Nadella - Chairman and CEO at Microsoft | LinkedIn</title>
        <meta property="og:title" content="Satya Nadella - Chairman and CEO at Microsoft | LinkedIn" />
        <meta property="og:image" content="https://media.licdn.com/dms/image/v2/D5603AQ/profile-displayphoto-shrink_800_800/0/123" />
        <script type="application/ld+json">
        {
          "@context": "https://schema.org",
          "@type": "Person",
          "name": "Satya Nadella",
          "jobTitle": "Chairman and CEO",
          "worksFor": {
            "@type": "Organization",
            "name": "Microsoft"
          },
          "alumniOf": {
            "@type": "EducationalOrganization",
            "name": "University of Chicago Booth School of Business"
          },
          "address": {
            "@type": "PostalAddress",
            "addressLocality": "Redmond",
            "addressRegion": "Washington",
            "addressCountry": "US"
          },
          "image": "https://media.licdn.com/dms/image/v2/D5603AQ/profile-displayphoto-shrink_800_800/0/123"
        }
        </script>
      </head>
      <body></body>
    </html>
  `;

  const jsonLdProfile = extractLinkedInFullProfileFromHtml(sampleJsonLdHtml);
  t.check("JSON-LD extracts full name", jsonLdProfile.fullName === "Satya Nadella");
  t.check("JSON-LD extracts first name", jsonLdProfile.firstName === "Satya");
  t.check("JSON-LD extracts last name", jsonLdProfile.lastName === "Nadella");
  t.check("JSON-LD extracts title", jsonLdProfile.title === "Chairman and CEO");
  t.check("JSON-LD extracts company", jsonLdProfile.company === "Microsoft");
  t.check("JSON-LD extracts school", jsonLdProfile.school === "University of Chicago Booth School of Business");
  t.check("JSON-LD extracts location", jsonLdProfile.location?.includes("Redmond") === true);
  t.check("JSON-LD extracts headshot", jsonLdProfile.imageUrl?.includes("media.licdn.com") === true);

  // OpenGraph fallback test
  const sampleOgHtml = `
    <!DOCTYPE html>
    <html>
      <head>
        <meta property="og:title" content="Jane Doe - VP of Engineering at Stripe | LinkedIn" />
        <meta property="og:description" content="Experience: VP of Engineering at Stripe · Education: Stanford University · Location: San Francisco, California" />
        <meta property="og:image" content="https://media.licdn.com/dms/image/v2/D5603AQ/profile-displayphoto-shrink_800_800/0/456" />
      </head>
      <body></body>
    </html>
  `;

  const ogProfile = extractLinkedInFullProfileFromHtml(sampleOgHtml);
  t.check("OG extracts full name", ogProfile.fullName === "Jane Doe");
  t.check("OG extracts title", ogProfile.title === "VP of Engineering");
  t.check("OG extracts company", ogProfile.company === "Stripe");
  t.check("OG extracts school", ogProfile.school === "Stanford University");
  t.check("OG extracts location", ogProfile.location === "San Francisco, California");
  t.check("OG extracts headshot", ogProfile.imageUrl?.includes("media.licdn.com") === true);

  // Split headline and name tests
  const splitName = splitFullName("Satya Nadella");
  t.check("splitFullName splits correctly", splitName.first === "Satya" && splitName.last === "Nadella");

  const headlineAt = splitHeadline("Staff Software Engineer at Google");
  t.check("splitHeadline with 'at'", headlineAt.title === "Staff Software Engineer" && headlineAt.company === "Google");

  const headlineDash = splitHeadline("Founder & CEO - Acme Corp");
  t.check("splitHeadline with '-'", headlineDash.title === "Founder & CEO" && headlineDash.company === "Acme Corp");

  // Name validation tests
  t.check("isLikelyPersonName accepts 'Satya Nadella'", isLikelyPersonName("Satya Nadella"));
  t.check("isLikelyPersonName rejects 'Sign In'", !isLikelyPersonName("Sign In | LinkedIn"));
  t.check("isLikelyPersonName rejects empty", !isLikelyPersonName(""));

  // --- Part 2: Integration tests against PGlite database ---
  const db = await getDb();
  const testSlug1 = `satya-test-${randomUUID()}`;
  const testSlug2 = `fallback-test-${randomUUID()}`;

  const mockPfpUrl1 = `https://media.licdn.com/dms/image/v2/D5603AQ/profile-displayphoto-shrink_800_800/0/${randomUUID()}`;

  // Insert initial contact with bare minimum info (no company, no title, no school, no location, generic name)
  const [c1] = await db
    .insert(contacts)
    .values({
      userId: TEST_USER,
      fullName: testSlug1, // slug as placeholder name
      linkedinUrl: `https://www.linkedin.com/in/${testSlug1}`,
      title: null,
      company: null,
      location: null,
      school: null,
      profileImageUrl: null,
    })
    .returning();

  // Contact 2: for testing public_work_history fallback
  const [c2] = await db
    .insert(contacts)
    .values({
      userId: TEST_USER,
      fullName: "Alex Rivera",
      linkedinUrl: `https://www.linkedin.com/in/${testSlug2}`,
      title: null,
      company: null,
    })
    .returning();

  // Seed public_work_history for contact 2
  await writePublicWorkHistory(testSlug2, {
    headline: "Chief Technology Officer at Orbit",
    experiences: [
      {
        kind: "role",
        organization: "Orbit",
        title: "Chief Technology Officer",
        fieldOfStudy: null,
        location: null,
        startYear: 2024,
        startMonth: null,
        endYear: null,
        endMonth: null,
        description: null,
        isCurrent: true,
      },
    ],
    sources: [],
  });

  // Mock global fetch to return sample LinkedIn HTML for testSlug1, and 404 for testSlug2
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
    const urlStr = url.toString();
    if (urlStr.includes(`linkedin.com/in/${testSlug1}`)) {
      return new Response(
        `<!DOCTYPE html>
        <html>
          <head>
            <meta property="og:title" content="Satya Nadella - Chairman and CEO at Microsoft | LinkedIn" />
            <meta property="og:image" content="${mockPfpUrl1}" />
            <script type="application/ld+json">
            {
              "@context": "https://schema.org",
              "@type": "Person",
              "name": "Satya Nadella",
              "jobTitle": "Chairman and CEO",
              "worksFor": { "@type": "Organization", "name": "Microsoft" },
              "alumniOf": { "@type": "EducationalOrganization", "name": "University of Chicago" },
              "address": { "@type": "PostalAddress", "addressLocality": "Redmond", "addressRegion": "WA" }
            }
            </script>
          </head>
        </html>`,
        { status: 200, headers: { "content-type": "text/html" } }
      );
    }
    if (urlStr.includes(`linkedin.com/in/${testSlug2}`)) {
      return new Response("Not found", { status: 404 });
    }
    if (urlStr.includes("licdn.com")) {
      return new Response(new Uint8Array([0x89, 0x50, 0x4e, 0x47]), {
        status: 200,
        headers: { "content-type": "image/png" },
      });
    }
    return originalFetch(url, init);
  }) as typeof globalThis.fetch;

  try {
    // Run refresh for c1
    const result1 = await refreshContactsFromLinkedIn([c1.id]);
    t.check("refresh result: refreshed 1", result1.refreshed === 1);
    t.check("refresh result: failed 0", result1.failed === 0);
    t.check("refresh result: not avatarOnly (updated profile details too)", result1.avatarOnly === false);

    // Verify contact in DB
    const [c1After] = await db
      .select()
      .from(contacts)
      .where(and(eq(contacts.id, c1.id), eq(contacts.userId, TEST_USER)));

    t.check("c1 title updated to 'Chairman and CEO'", c1After?.title === "Chairman and CEO");
    t.check("c1 company updated to 'Microsoft'", c1After?.company === "Microsoft");
    t.check("c1 school updated to 'University of Chicago'", c1After?.school === "University of Chicago");
    t.check("c1 location updated to 'Redmond, WA'", c1After?.location === "Redmond, WA");
    t.check("c1 fullName updated to 'Satya Nadella'", c1After?.fullName === "Satya Nadella");
    t.check("c1 firstName updated to 'Satya'", c1After?.firstName === "Satya");
    t.check("c1 lastName updated to 'Nadella'", c1After?.lastName === "Nadella");
    t.check("c1 profileImageCheckedAt updated", Boolean(c1After?.profileImageCheckedAt));

    // Verify shared pool adopted avatar
    const sharedRow = await getSharedAvatar(testSlug1);
    t.check("shared pool contains photo for slug", Boolean(sharedRow?.imageUrl));
    t.check("shared pool source is 'linkedin_direct'", sharedRow?.source === "linkedin_direct");

    // Run refresh for c2 (direct scrape fails with 404, falls back to public_work_history)
    const result2 = await refreshContactsFromLinkedIn([c2.id]);
    t.check("c2 refreshed via fallback", result2.refreshed === 1);

    const [c2After] = await db
      .select()
      .from(contacts)
      .where(and(eq(contacts.id, c2.id), eq(contacts.userId, TEST_USER)));

    t.check("c2 title fallback from work history", c2After?.title === "Chief Technology Officer");
    t.check("c2 company fallback from work history", c2After?.company === "Orbit");

  } finally {
    globalThis.fetch = originalFetch;

    // Clean up test records
    await db.delete(contacts).where(inArray(contacts.id, [c1.id, c2.id]));
    await db.delete(linkedinAvatars).where(inArray(linkedinAvatars.slug, [testSlug1, testSlug2]));
  }

  t.done("smoke-linkedin-refresh");
}

main().catch((err) => {
  console.error("smoke test failed with error:", err);
  process.exit(1);
});
