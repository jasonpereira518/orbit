/**
 * The extension's candidate lookup (`matchesForPage` in `src/lib/extension/resolve.ts`) runs
 * on every profile the extension opens. Its arms used to be ILIKEs on raw columns (one a
 * leading-wildcard match on linkedin_url), which sent the query to a scan of the user's
 * whole network. They are now index-served: identifiers through `contact_identities`, the
 * LinkedIn slug through the generated column, names through lower() for the trigram index.
 *
 * What must still hold: a contact is found by its LinkedIn profile whether or not its
 * identities have been claimed yet (old contacts are backfilled over successive deploys),
 * URL variants still resolve to the same person, and another user's contact never does.
 *
 * Local PGlite. Run: npx tsx scripts/smoke-extension-candidates.ts
 */
import "./smoke/_env";
import { eq } from "drizzle-orm";
import { getDb } from "../src/db";
import { contacts } from "../src/db/schema";
import { claimIdentities } from "../src/lib/contact-identity";
import { matchesForPage } from "../src/lib/extension/resolve";
import type { PageContext } from "../src/lib/extension/contract";
import { identityKeysFor } from "../src/lib/duplicates";

const USER = "smoke-ext-candidates";

let failures = 0;
function check(label: string, ok: boolean, detail?: string) {
  if (ok) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.error(`  FAIL ${label}${detail ? `\n       ${detail}` : ""}`);
  }
}

const field = (value: string | null | undefined, source = "h1") => (value ? { value, source, confidence: "high" as const } : null);
function page(p: { name?: string; url: string }): PageContext {
  return {
    schemaVersion: 1, site: "linkedin", adapterVersion: "smoke", kind: "person",
    url: p.url, sourceUrl: p.url, capturedAt: "2026-01-01T00:00:00.000Z",
    identity: {
      name: field(p.name), headline: null, title: null, company: null, location: null, school: null, email: null,
      handle: field(p.url, "url"), profileUrl: field(p.url, "url"), photoUrl: null,
    },
    text: { blob: p.name ?? "", truncated: false, charCount: (p.name ?? "").length, fromSelection: false },
    warnings: [],
  } as PageContext;
}

async function main() {
  const db = await getDb();
  await db.delete(contacts).where(eq(contacts.userId, USER));
  await db.delete(contacts).where(eq(contacts.userId, `${USER}-other`));

  // Written raw: no identities claimed, like a contact from before the table existed.
  const [legacy] = await db.insert(contacts).values({ userId: USER, fullName: "Legacy Lin", linkedinUrl: "https://www.linkedin.com/in/legacy-lin/" }).returning();
  // Claimed the way every current write path claims.
  const [claimed] = await db.insert(contacts).values({ userId: USER, fullName: "Claimed Cho", linkedinUrl: "https://linkedin.com/in/Claimed-Cho?trk=x" }).returning();
  await claimIdentities(USER, claimed!.id, identityKeysFor({ linkedinUrl: claimed!.linkedinUrl }));
  // Someone else's contact with the same profile.
  await db.insert(contacts).values({ userId: `${USER}-other`, fullName: "Legacy Lin", linkedinUrl: "https://www.linkedin.com/in/legacy-lin" });

  const legacyHit = await matchesForPage(USER, page({ url: "https://www.linkedin.com/in/legacy-lin" }));
  check("a contact without claimed identities is found by its profile", legacyHit.matches[0]?.contact.id === legacy!.id, JSON.stringify(legacyHit.matches.map((m) => m.contact.fullName)));
  check("and only that user's", legacyHit.matches.every((m) => m.contact.id === legacy!.id));

  const claimedHit = await matchesForPage(USER, page({ url: "https://uk.linkedin.com/in/claimed-cho/?miniProfileUrn=abc" }));
  check("a URL variant (locale, case, query) resolves to the claimed contact", claimedHit.matches[0]?.contact.id === claimed!.id, JSON.stringify(claimedHit.matches.map((m) => m.contact.fullName)));

  const byName = await matchesForPage(USER, page({ name: "Claimed Cho", url: "https://www.linkedin.com/in/someone-else-entirely" }));
  check("a name alone still surfaces the contact as a candidate", byName.matches.some((m) => m.contact.id === claimed!.id), JSON.stringify(byName.matches.map((m) => m.contact.fullName)));

  const none = await matchesForPage(USER, page({ name: "Nobody Here", url: "https://www.linkedin.com/in/nobody-here" }));
  check("a stranger matches nobody", none.matches.length === 0);

  await db.delete(contacts).where(eq(contacts.userId, USER));
  await db.delete(contacts).where(eq(contacts.userId, `${USER}-other`));
  if (failures) {
    console.error(`\n${failures} check(s) failed`);
    process.exit(1);
  }
  console.log("\nAll extension candidate checks passed");
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
