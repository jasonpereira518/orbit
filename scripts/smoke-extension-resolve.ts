/**
 * "Do I already know this person?" — the extension's resolve, on the identity spine.
 *
 * The one question the panel exists to answer, and until now untested. The failure
 * that matters is the silent one: the panel confidently says "new to your orbit"
 * about someone the user has known for years. Each case below is a way that used
 * to happen, or a way the fix could overreach:
 *
 *   - LinkedIn URLs stored with a locale subdomain and tracking junk still match
 *     (now through the indexed `linkedin_slug` column, not a wildcard ILIKE).
 *   - An X handle stored as "@AmaraOsei" matches x.com/amaraosei — the column
 *     comparison misses it; the identity spine (normalized on write) does not.
 *   - A personal site that LINKS to someone's LinkedIn matches them. The resolver
 *     used to ignore that link because the page itself wasn't on LinkedIn.
 *   - …but a `/in/<slug>` path on some other host is not a LinkedIn key.
 *   - Two contacts claiming one profile stay ambiguous — a real duplicate the user
 *     must see, never silently resolved to one of them.
 *   - Another user's contacts are never candidates.
 *
 * Run: npx tsx scripts/smoke-extension-resolve.ts
 */
import "./smoke/_env";
import { run } from "./smoke/_env";
import { eq } from "drizzle-orm";
import { getDb } from "../src/db";
import { contactIdentities, contacts } from "../src/db/schema";
import { claimIdentities } from "../src/lib/contact-identity";
import { identityKeysFor } from "../src/lib/duplicates";
import type { PageContext } from "../src/lib/extension/contract";
import { matchesForPage } from "../src/lib/extension/resolve";

const USER = "smoke-ext-resolve-user";
const OTHER = "smoke-ext-resolve-other";

let failures = 0;
function check(label: string, ok: boolean, detail?: string) {
  if (ok) console.log(`  ok   ${label}`);
  else {
    console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ""}`);
    failures++;
  }
}

async function cleanup() {
  const db = await getDb();
  for (const user of [USER, OTHER]) {
    await db.delete(contactIdentities).where(eq(contactIdentities.userId, user));
    await db.delete(contacts).where(eq(contacts.userId, user));
  }
}

/** A contact as an import would leave it: raw columns, identities claimed. */
async function seed(
  userId: string,
  values: { fullName: string; linkedinUrl?: string; xHandle?: string; email?: string }
) {
  const db = await getDb();
  const [row] = await db.insert(contacts).values({ userId, ...values }).returning();
  await claimIdentities(userId, row.id, identityKeysFor(values), "smoke");
  return row;
}

const field = (value: string) => ({ value, source: "smoke", confidence: "high" as const });

function page(over: {
  site: PageContext["site"];
  url: string;
  name?: string;
  profileUrl?: string;
  handle?: string;
}): PageContext {
  return {
    schemaVersion: 1,
    site: over.site,
    adapterVersion: "smoke-1",
    kind: "person",
    url: over.url,
    sourceUrl: over.url,
    capturedAt: new Date().toISOString(),
    identity: {
      name: over.name ? field(over.name) : null,
      headline: null,
      title: null,
      company: null,
      location: null,
      school: null,
      email: null,
      handle: over.handle ? field(over.handle) : null,
      profileUrl: over.profileUrl ? field(over.profileUrl) : null,
      photoUrl: null,
    },
    text: { blob: "", truncated: false, charCount: 0, fromSelection: false },
    warnings: [],
  };
}

run(async () => {
  await cleanup();

  const amara = await seed(USER, {
    fullName: "Amara Osei",
    // As a real import stores it: locale subdomain, trailing slash, tracking.
    linkedinUrl: "https://de.linkedin.com/in/amara-osei/?trk=public_profile",
    // As a user types it.
    xHandle: "@AmaraOsei",
  });
  // Someone else's contact, on the SAME profile — must never surface.
  await seed(OTHER, { fullName: "Amara Osei", linkedinUrl: "https://www.linkedin.com/in/amara-osei" });

  console.log("LinkedIn");
  let r = await matchesForPage(
    USER,
    page({ site: "linkedin", url: "https://www.linkedin.com/in/amara-osei", name: "Amara Osei", handle: "amara-osei" })
  );
  check("a locale-variant stored URL is a confident match", r.status === "confident", r.status);
  check("…and it's the right person", r.matches[0]?.contact.id === amara.id);
  check(
    "another user's contact on the same profile is never a candidate",
    r.matches.every((m) => m.contact.userId === USER),
    JSON.stringify(r.matches.map((m) => m.contact.userId))
  );

  console.log("X");
  r = await matchesForPage(USER, page({ site: "x", url: "https://x.com/amaraosei", handle: "amaraosei" }));
  check(
    'a handle stored as "@AmaraOsei" matches x.com/amaraosei',
    r.status === "confident" && r.matches[0]?.contact.id === amara.id,
    `${r.status} ${r.matches.length}`
  );

  console.log("links on other sites");
  r = await matchesForPage(
    USER,
    page({
      site: "generic",
      url: "https://amara.dev/about",
      name: "Amara Osei",
      profileUrl: "https://www.linkedin.com/in/amara-osei",
    })
  );
  check(
    "a personal site linking to their LinkedIn matches them",
    r.status === "confident" && r.matches[0]?.contact.id === amara.id,
    `${r.status} ${JSON.stringify(r.matches.map((m) => m.reason))}`
  );

  r = await matchesForPage(
    USER,
    page({ site: "generic", url: "https://amara.dev/about", handle: "amaraosei" })
  );
  check(
    "a personal site linking to their X matches them",
    r.status === "confident" && r.matches[0]?.contact.id === amara.id,
    `${r.status} ${JSON.stringify(r.matches.map((m) => m.reason))}`
  );

  r = await matchesForPage(
    USER,
    page({ site: "generic", url: "https://example.com/team", profileUrl: "https://example.com/in/amara-osei" })
  );
  check(
    "an /in/ path on another host is not a LinkedIn key",
    r.matches.every((m) => m.reason !== "Same LinkedIn URL"),
    JSON.stringify(r.matches.map((m) => m.reason))
  );

  console.log("duplicates stay visible");
  // A bad import left two contacts on one profile. The identity index lets only one
  // own it; the column still finds both — and that must read as ambiguous.
  const db = await getDb();
  const [twin] = await db
    .insert(contacts)
    .values({ userId: USER, fullName: "Amara Osei", linkedinUrl: "https://www.linkedin.com/in/amara-osei" })
    .returning();
  r = await matchesForPage(
    USER,
    page({ site: "linkedin", url: "https://www.linkedin.com/in/amara-osei", name: "Amara Osei", handle: "amara-osei" })
  );
  check("two contacts on one profile are ambiguous, not silently one", r.status === "ambiguous", r.status);
  check(
    "…and both are offered",
    [amara.id, twin.id].every((id) => r.matches.some((m) => m.contact.id === id)),
    JSON.stringify(r.matches.map((m) => m.contact.fullName))
  );

  console.log("strangers");
  r = await matchesForPage(
    USER,
    page({ site: "linkedin", url: "https://www.linkedin.com/in/someone-new", name: "Someone New", handle: "someone-new" })
  );
  check("someone the user doesn't know is 'none'", r.status === "none", r.status);

  await cleanup();
  if (failures) {
    console.error(`\nsmoke-extension-resolve: ${failures} check(s) failed`);
    process.exit(1);
  }
  console.log("\nsmoke-extension-resolve: all checks passed");
});
