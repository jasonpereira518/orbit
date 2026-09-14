/**
 * Outreach identity rules. These MUST agree with `contact_identities` (src/lib/duplicates.ts):
 * the "already in your contacts" flag is an equality probe between the two tables, so a second
 * spelling of the same rule would silently stop flagging people.
 *
 * Run: npx tsx scripts/smoke-outreach-identity.ts
 */
import { identityKeysFor } from "../src/lib/duplicates";
import {
  canonicalLinkedinUrl,
  externalIdFor,
  isLinkedinProfileUrl,
  likelySamePerson,
  normalizeEmail,
  outreachIdentitiesFor,
} from "../src/lib/outreach/identity";

let failures = 0;
function check(label: string, ok: boolean, detail?: string) {
  if (ok) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.error(`  FAIL ${label}${detail ? `\n       ${detail}` : ""}`);
  }
}

const a = outreachIdentitiesFor({ linkedinUrl: "https://uk.linkedin.com/in/Jane-Doe/?trk=public" });
const b = outreachIdentitiesFor({ linkedinUrl: "linkedin.com/in/jane-doe" });
check("LinkedIn URL variants normalize to one slug", JSON.stringify(a) === JSON.stringify(b), JSON.stringify(a));
check("the slug matches contact_identities exactly",
  a[0]?.value === identityKeysFor({ linkedinUrl: "https://uk.linkedin.com/in/Jane-Doe/?trk=public" })[0]?.value);

check("company pages are not profiles", !isLinkedinProfileUrl("https://www.linkedin.com/company/stripe"));
check("posts are not profiles", !isLinkedinProfileUrl("https://www.linkedin.com/posts/jane-doe_activity-1"));
check("profile URLs are profiles", isLinkedinProfileUrl("https://www.linkedin.com/in/jane-doe"));
check("canonical URL", canonicalLinkedinUrl("https://de.linkedin.com/in/Jane-Doe?x=1") === "https://www.linkedin.com/in/jane-doe");
check("canonical URL of a non-profile is null", canonicalLinkedinUrl("https://example.com/in/jane") === null);
check("a non-profile URL never becomes an identity",
  outreachIdentitiesFor({ linkedinUrl: "https://www.linkedin.com/company/stripe" }).length === 0);

const withEmail = outreachIdentitiesFor({ email: "  Jane.Doe@Stripe.com ", apolloId: "ap_123", linkedinUrl: "https://linkedin.com/in/jane-doe" });
check("email is lower-cased and trimmed", withEmail.some((k) => k.kind === "email" && k.value === "jane.doe@stripe.com"));
check("apollo id is an identity", withEmail.some((k) => k.kind === "apollo" && k.value === "ap_123"));
check("identities are sorted by kind", withEmail.map((k) => k.kind).join(",") === "apollo,email,linkedin_slug");
check("role emails are not identities", outreachIdentitiesFor({ email: "info@stripe.com" }).length === 0);

check("external id prefers LinkedIn", externalIdFor(withEmail) === "li:jane-doe");
check("then Apollo", externalIdFor(outreachIdentitiesFor({ email: "x@y.com", apolloId: "ap_1" })) === "apollo:ap_1");
check("then email", externalIdFor(outreachIdentitiesFor({ email: "x@y.com" })) === "email:x@y.com");
check("otherwise a manual id", /^manual:[0-9a-f-]{36}$/.test(externalIdFor([])));

check("normalizeEmail rejects garbage", normalizeEmail("not-an-email") === null);
check("normalizeEmail keeps a real address", normalizeEmail("A@B.io") === "a@b.io");

check("same name + same company is likely the same person",
  likelySamePerson({ fullName: "Jane Doe", company: "Stripe" }, { fullName: "Jane  Doe", company: "stripe" }));
check("same name at different companies is not",
  !likelySamePerson({ fullName: "Jane Doe", company: "Stripe" }, { fullName: "Jane Doe", company: "Plaid" }));
check("different names are not",
  !likelySamePerson({ fullName: "Jane Doe", company: "Stripe" }, { fullName: "John Roe", company: "Stripe" }));

if (failures > 0) {
  console.error(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log("\nAll outreach identity checks passed.");
