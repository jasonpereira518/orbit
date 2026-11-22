/**
 * Smoke test for monthly contact upkeep engine:
 * 1. Audits and repairs generic/missing/stale avatars using direct LinkedIn scraper & shared pool.
 * 2. Resolves handle names to verified real names using LinkedIn og:title metadata and fallbacks.
 * 3. Immediate pooling in shared database benefits subsequent users.
 * 4. Correctly ignores fresh contacts, tour examples, and other accounts.
 *
 * Run: npx tsx scripts/smoke-contact-monthly-upkeep.ts
 */
import "./smoke/_env";

import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { getDb } from "../src/db";
import { contacts, linkedinAvatars } from "../src/db/schema";
import {
  runMonthlyContactUpkeep,
  usersWithMonthlyUpkeepCandidates,
  type MonthlyUpkeepDeps,
} from "../src/lib/contact-monthly-upkeep";
import { getSharedAvatar } from "../src/lib/shared-avatars";
import { checker } from "./smoke/check";

delete process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY;
delete process.env.CLERK_SECRET_KEY;
// Blob unconfigured, so a shared photo is adopted as its raw https URL (the CI path). With a
// developer's Blob credentials in `.env.local`, adoption would try the live store instead:
// offline it fails and the pool stays empty, and online it uploads to a real bucket.
delete process.env.BLOB_READ_WRITE_TOKEN;
delete process.env.BLOB_STORE_ID;
delete process.env.VERCEL_OIDC_TOKEN;
(process.env as Record<string, string>).NODE_ENV = "development";
process.env.ORBIT_DEMO_DATA = "off";

const t = checker();
const USER_A = `smoke-monthly-${randomUUID()}`;
const USER_B = `smoke-monthly-b-${randomUUID()}`;

async function main() {
  const db = await getDb();

  // Test setup:
  // 1. Contact with generic aero placeholder and handle name + LinkedIn URL
  const testSlug = `upkeep-test-${randomUUID()}`;
  const linkedinUrl = `https://www.linkedin.com/in/${testSlug}`;

  const [c1] = await db
    .insert(contacts)
    .values({
      userId: USER_A,
      fullName: "satya.nadella",
      email: "satya@microsoft.com",
      linkedinUrl,
      profileImageUrl: "https://static.licdn.com/aero-v1/sc/h/9c5451dg44r8owwmb36996w5t", // generic LinkedIn icon
      profileImageCheckedAt: new Date(Date.now() - 40 * 86_400_000), // 40 days stale
    })
    .returning();

  // 2. Contact with orbit:no-photo placeholder
  const [c2] = await db
    .insert(contacts)
    .values({
      userId: USER_A,
      fullName: "jsmith42",
      email: "jsmith42@acme.com",
      profileImageUrl: "orbit:no-photo:generic",
    })
    .returning();

  // 3. Contact already clean and fresh (should NOT be picked up as candidate)
  const [c3] = await db
    .insert(contacts)
    .values({
      userId: USER_A,
      fullName: "Satya Nadella",
      email: "satya.clean@microsoft.com",
      profileImageUrl: "https://media.licdn.com/dms/image/v2/D5603AQ/profile-displayphoto-shrink_800_800/0/123",
      profileImageCheckedAt: new Date(),
    })
    .returning();

  // 4. Contact belonging to tour example (should NOT be touched)
  const [c4] = await db
    .insert(contacts)
    .values({
      userId: USER_A,
      fullName: "tour_handle",
      email: "tour@example.com",
      source: "tour-example",
      profileImageUrl: "orbit:no-photo:generic",
    })
    .returning();

  // Test candidate detection
  const candidateUsers = await usersWithMonthlyUpkeepCandidates(10);
  t.check("candidate detection finds USER_A", candidateUsers.includes(USER_A));

  // Intercept / mock network fetch for LinkedIn scraper direct HTML
  const originalFetch = globalThis.fetch;
  const mockPfpUrl = `https://media.licdn.com/dms/image/v2/D5603AQ/profile-displayphoto-shrink_800_800/0/${randomUUID()}`;

  globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
    const urlStr = url.toString();
    if (urlStr.includes(`linkedin.com/in/${testSlug}`)) {
      const html = `
        <!DOCTYPE html>
        <html>
          <head>
            <meta property="og:title" content="Satya Nadella - Chairman and CEO - Microsoft | LinkedIn" />
            <meta property="og:image" content="${mockPfpUrl}" />
          </head>
          <body></body>
        </html>
      `;
      return new Response(html, {
        status: 200,
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    }
    return originalFetch(url, init);
  }) as typeof fetch;

  const deps: Partial<MonthlyUpkeepDeps> = {
    providerIndex: async () =>
      new Map([["jsmith42@acme.com", { first: "Jane", last: "Smithers", full: "Jane Smithers" }]]),
    askAi: async () => null,
  };

  try {
    const stats = await runMonthlyContactUpkeep(USER_A, { deps });
    t.check("upkeep checked candidates", stats.checked === 2, `checked: ${stats.checked}`);
    t.check("upkeep updated avatars", stats.avatarsUpdated === 1, `avatarsUpdated: ${stats.avatarsUpdated}`);
    t.check("upkeep fixed handle names", stats.namesFixed === 2, `namesFixed: ${stats.namesFixed}`);

    // Verify contact 1 updates
    const [c1Updated] = await db.select().from(contacts).where(eq(contacts.id, c1.id));
    t.check("c1 name updated from LinkedIn og:title", c1Updated.fullName === "Satya Nadella", c1Updated.fullName);
    t.check("c1 first name populated", c1Updated.firstName === "Satya", c1Updated.firstName ?? "");
    t.check("c1 last name populated", c1Updated.lastName === "Nadella", c1Updated.lastName ?? "");
    t.check("c1 avatar updated to LinkedIn photo", c1Updated.profileImageUrl === mockPfpUrl, c1Updated.profileImageUrl ?? "");
    t.check("c1 avatar checked stamp updated", c1Updated.profileImageCheckedAt !== null);

    // Verify contact 2 updates
    const [c2Updated] = await db.select().from(contacts).where(eq(contacts.id, c2.id));
    t.check("c2 name updated from address book", c2Updated.fullName === "Jane Smithers", c2Updated.fullName);

    // Verify contact 3 (clean) untouched
    const [c3Updated] = await db.select().from(contacts).where(eq(contacts.id, c3.id));
    t.check("c3 clean contact untouched", c3Updated.fullName === "Satya Nadella");

    // Verify contact 4 (tour) untouched
    const [c4Updated] = await db.select().from(contacts).where(eq(contacts.id, c4.id));
    t.check("c4 tour example untouched", c4Updated.fullName === "tour_handle");

    // Verify shared pool adoption: the photo was saved to linkedin_avatars
    const shared = await getSharedAvatar(testSlug);
    t.check("photo adopted into shared pool", shared?.imageUrl === mockPfpUrl);
    t.check("shared pool source is linkedin_direct", shared?.source === "linkedin_direct");

    // Verify that USER_B with the same LinkedIn URL now resolves from shared pool immediately
    const [cUserB] = await db
      .insert(contacts)
      .values({
        userId: USER_B,
        fullName: "Another Colleague",
        linkedinUrl,
        profileImageUrl: null,
      })
      .returning();

    // Reset fetch to fail for LinkedIn so we prove USER_B resolves from the shared DB pool
    globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
      const urlStr = url.toString();
      if (urlStr.includes("linkedin.com")) {
        return new Response("Forbidden", { status: 403 });
      }
      return originalFetch(url, init);
    }) as typeof fetch;

    const statsB = await runMonthlyContactUpkeep(USER_B);
    t.check("USER_B resolved avatar from shared pool", statsB.avatarsUpdated === 1, `avatarsUpdated: ${statsB.avatarsUpdated}`);

    const [cBUpdated] = await db.select().from(contacts).where(eq(contacts.id, cUserB.id));
    t.check("cB got shared photo URL", cBUpdated.profileImageUrl === mockPfpUrl, cBUpdated.profileImageUrl ?? "");

  } finally {
    globalThis.fetch = originalFetch;

    // Cleanup
    await db.delete(contacts).where(inArray(contacts.userId, [USER_A, USER_B]));
    await db.delete(linkedinAvatars).where(eq(linkedinAvatars.slug, testSlug));
  }

  t.done("monthly contact upkeep smoke tests");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
