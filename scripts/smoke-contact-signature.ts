/**
 * Contact signatures (`src/lib/contact-signature.ts`, contact-info accuracy plan PR 8): role,
 * company, phone and LinkedIn link read from the sender's own sign-off block only.
 */
import "./smoke/_env";
import { parseSignature } from "../src/lib/contact-signature";
import { checker } from "./smoke/check";

const t = checker();
const priya = { name: "Priya Raman", email: "priya@stripe.com" };

console.log("common shapes");
{
  const a = parseSignature("Hi Jason,\n\nGreat to meet you.\n\nBest,\nPriya Raman\nSenior Recruiter | Stripe\n+1 (555) 010-0199\nlinkedin.com/in/priya-raman", priya);
  t.check("role | company", a.title === "Senior Recruiter" && a.company === "Stripe", JSON.stringify(a));
  t.check("phone", a.phone === "+1 (555) 010-0199", String(a.phone));
  t.check("LinkedIn link", a.linkedinUrl === "https://linkedin.com/in/priya-raman", String(a.linkedinUrl));
  const b = parseSignature("Thanks!\n\n-- \nPriya Raman\nHead of Talent\nStripe\nm. 555-010-0199", priya);
  t.check("role then company on the next line", b.title === "Head of Talent" && b.company === "Stripe", JSON.stringify(b));
  const c = parseSignature("Cheers,\nPriya Raman\nHead of Talent at Stripe", priya);
  t.check("role at company", c.title === "Head of Talent" && c.company === "Stripe", JSON.stringify(c));
}

console.log("what is never read");
{
  const quoted = parseSignature("Sounds good.\n\nOn Tue, Nov 11, 2026 at 9:00 AM Priya Raman <priya@stripe.com> wrote:\n> Priya Raman\n> VP People | Stripe", priya);
  t.check("a quoted signature", Object.keys(quoted).length === 0, JSON.stringify(quoted));
  const mention = parseSignature("I spoke with Priya Raman yesterday about the role.\nThanks", priya);
  t.check("a mention that is not a sign-off line", Object.keys(mention).length === 0, JSON.stringify(mention));
  const other = parseSignature("Best,\nPriya Raman\nSenior Recruiter | Initech", priya);
  t.check("a company that contradicts their work email", other.company === undefined && other.title === "Senior Recruiter", JSON.stringify(other));
  const firstOnly = parseSignature("Best,\nPriya\nRecruiter", { name: "Priya", email: "priya@stripe.com" });
  t.check("a first name alone", Object.keys(firstOnly).length === 0);
  const gmail = parseSignature("Best,\nPriya Raman\nFounder | Tiny Labs", { name: "Priya Raman", email: "priya@gmail.com" });
  t.check("public mail: the signature's company is all there is", gmail.company === "Tiny Labs", JSON.stringify(gmail));
  const url = parseSignature("Best,\nPriya Raman\nhttps://stripe.com\n555-010-0199", priya);
  t.check("a link is not a role", url.title === undefined && url.phone === "555-010-0199", JSON.stringify(url));
}

t.done("contact signature smoke tests");
