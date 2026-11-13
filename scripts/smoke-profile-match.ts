/**
 * The profile finder's checks (`src/lib/profile-match.ts`): a found LinkedIn URL counts only
 * when the search cited it, and a profile found by name is this contact only when the name
 * matches AND a company or school does. No database, no model.
 */
import "./smoke/_env";
import { citedLinkedInUrl, corroborates, findableWithoutUrl } from "../src/lib/profile-match";
import { checker } from "./smoke/check";

const t = checker();
const role = (organization: string) => ({ kind: "role", organization });
const school = (organization: string) => ({ kind: "education", organization });

console.log("cited URLs only");
{
  const sources = [{ url: "https://www.linkedin.com/in/dana-whitfield/" }, { url: "https://stripe.com/team" }];
  t.check("a cited profile, canonical", citedLinkedInUrl("linkedin.com/in/Dana-Whitfield", sources) === "https://www.linkedin.com/in/dana-whitfield");
  t.check("one the model composed is dropped", citedLinkedInUrl("https://www.linkedin.com/in/dana-w-42", sources) === null);
  t.check("a company page is not a profile", citedLinkedInUrl("https://www.linkedin.com/company/stripe", sources) === null);
  t.check("nothing reported, nothing kept", citedLinkedInUrl(null, sources) === null);
}

console.log("enough to search on");
const base = { fullName: "Dana Whitfield", company: null, email: null, school: null };
t.check("a first name alone is not", !findableWithoutUrl({ ...base, fullName: "Dana", company: "Stripe" }));
t.check("a full name alone is not", !findableWithoutUrl(base));
t.check("full name + company is", findableWithoutUrl({ ...base, company: "Stripe" }));
// Only an email is not enough: the domain is never sent to the search (see findableWithoutUrl).
t.check("full name + only an email is not", !findableWithoutUrl({ fullName: "Dana Whitfield", company: null, school: null }));
t.check("full name + school is", findableWithoutUrl({ ...base, school: "MIT" }));

console.log("corroboration");
t.check("same name, same company", corroborates({ ...base, company: "Stripe" }, { name: "Dana Whitfield", experiences: [role("Stripe, Inc.")] }));
t.check("company from a work email", corroborates({ ...base, email: "dana@stripe.com" }, { name: "Dana Whitfield", experiences: [role("Stripe")] }));
t.check("same school", corroborates({ ...base, school: "MIT" }, { name: "Dana Whitfield", experiences: [school("MIT")] }));
t.check("reordered name is fine", corroborates({ ...base, company: "Stripe" }, { name: "Whitfield Dana", experiences: [role("Stripe")] }));
t.check("a namesake at another company is not", !corroborates({ ...base, company: "Stripe" }, { name: "Dana Whitfield", experiences: [role("Barclays")] }));
t.check("a different person at the same company is not", !corroborates({ ...base, company: "Stripe" }, { name: "Dan Whitman", experiences: [role("Stripe")] }));
t.check("no name in the answer is not", !corroborates({ ...base, company: "Stripe" }, { name: null, experiences: [role("Stripe")] }));
t.check("a school does not stand in for a company", !corroborates({ ...base, company: "MIT" }, { name: "Dana Whitfield", experiences: [school("Harvard")] }));

t.done("profile match smoke tests");
