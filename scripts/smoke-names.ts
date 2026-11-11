/**
 * The names module (`src/lib/names/`): one table of real-shaped inputs per rule, plus the
 * frozen lists that stored keys depend on. Pure: no database, no model.
 */
import { classifyMailbox, classifyName, isPersonName, type NameVerdict } from "../src/lib/names/classify";
import { compareNames, shouldReplaceName, type NameRelation } from "../src/lib/names/compare";
import { nameFromEmail, nameFromHandle, nameFromSlug } from "../src/lib/names/from-identifier";
import { nameKey } from "../src/lib/names/key";
import { sameGivenName } from "../src/lib/names/nicknames";
import { formatPersonName, splitName } from "../src/lib/names/parse";
import { identityKeysFor, isRoleEmail } from "../src/lib/duplicates";
import { checker } from "./smoke/check";

const t = checker();

console.log("nameKey");
for (const [a, b] of [
  ["José O'Neil", "jose o neil"],
  ["  Anne-Marie  ", "anne marie"],
  ["李伟", "李伟"],
  ["Zoë", "zoe"],
] as const) {
  t.check(`key("${a}") = "${b}"`, nameKey(a) === b, nameKey(a));
}

console.log("formatPersonName");
for (const [raw, want] of [
  ["Doe, Jane", "Jane Doe"],
  ["DOE, JANE", "Jane Doe"],
  ["jane doe", "Jane Doe"],
  ["Jane Doe (Acme)", "Jane Doe"],
  ["Jane Doe via Google Docs", "Jane Doe"],
  ["Jane Doe | Acme Corp", "Jane Doe"],
  ['"Jane Doe"', "Jane Doe"],
  ["Dr. Jane Doe", "Jane Doe"],
  ["Jane Doe, PhD", "Jane Doe"],
  ["John Smith, Jr.", "John Smith Jr."],
  ["PATRICK O'BRIEN", "Patrick O'Brien"],
  ["ludwig van beethoven", "Ludwig van Beethoven"],
  ["DeShawn McKinsey", "DeShawn McKinsey"],
  ["李伟", "李伟"],
] as const) {
  const got = formatPersonName(raw)?.fullName;
  t.check(`"${raw}" → "${want}"`, got === want, String(got));
}
const split = splitName("Ada King Lovelace");
t.check("split is first + the rest", split.firstName === "Ada" && split.lastName === "King Lovelace");
t.check("one word is a first name", splitName("Priya").lastName === null);

console.log("classifyName");
const cases: Array<[string, NameVerdict, boolean?, { email?: string; company?: string }?]> = [
  ["Sarah Chen", "person_full"],
  ["José Ruiz", "person_full"],
  ["Mary-Kate O'Neil", "person_full"],
  ["Ai Nakamura", "person_full"],
  ["李伟", "person_full"],
  ["Priya", "person_partial"],
  ["Anna", "person_partial"],
  ["An", "person_partial"],
  ["Doe, Jane", "person_full"],
  ["Ann Calendar", "person_full"],
  ["jsmith42", "handle"],
  ["john.doe", "handle"],
  ["cher", "handle", false, { email: "cher@x.com" }],
  ["jane@x.com", "email", true],
  ["+1 (555) 123-4567", "phone", true],
  ["", "placeholder", true],
  ["Unknown", "placeholder", true],
  ["LinkedIn contact", "placeholder", true],
  ["Executive Candidate 3", "placeholder", true],
  ["Speaker 1", "placeholder", true],
  ["the recruiter", "placeholder", false],
  ["Hiring Manager", "placeholder", false],
  ["Acme Inc", "organization", true],
  ["Smith Holdings LLC", "organization", true],
  ["Acme Labs", "organization", false],
  ["University of Michigan", "organization", false],
  ["Growth Team", "organization", false],
  ["Talent Acquisition", "organization", false],
  ["Human Resources", "organization", false],
  ["Acme Support", "organization", false],
  ["IBM", "organization", false],
  ["Y Combinator 2024", "organization", false],
  ["Smith & Co", "organization", false],
  ["Stripe", "organization", false, { company: "Stripe" }],
  ["Interview Calendar 2", "mailbox", true],
  ["Conference Room B", "mailbox", true],
  ["Jane Doe", "mailbox", true, { email: "noreply@acme.com" }],
  ["support", "mailbox", false, { email: "support@acme.com" }],
  ["Jane Doe", "person_full", false, { email: "hello@janedoe.com" }],
  ["Jane and John", "group"],
  ["Jane, Alex, Sam", "group"],
];
for (const [raw, verdict, certain, ctx] of cases) {
  const got = classifyName(raw, ctx);
  const ok = got.verdict === verdict && (certain === undefined || got.certain === certain);
  t.check(`"${raw}"${ctx ? ` ${JSON.stringify(ctx)}` : ""} → ${verdict}${certain === undefined ? "" : certain ? " (certain)" : " (likely)"}`, ok, JSON.stringify(got));
}
t.check("a person-shaped name is a person", isPersonName("Sarah Chen") && !isPersonName("Acme Inc"));

console.log("mailboxes");
t.check("noreply is machine", classifyMailbox("noreply@x.com") === "machine");
t.check("a +tag is still the mailbox", classifyMailbox("notifications+123@x.com") === "machine");
t.check("a group calendar is machine", classifyMailbox("abc@group.calendar.google.com") === "machine");
t.check("info@ is role", classifyMailbox("info@acme.com") === "role");
t.check("jane@ is person", classifyMailbox("jane@acme.com") === "person");
// FROZEN: identityKeysFor refuses exactly these as identities; a change re-keys stored rows.
for (const local of ["info", "hello", "team", "sales", "careers", "noreply", "newsletter"]) {
  t.check(`${local}@ is never an email identity`, isRoleEmail(`${local}@acme.com`) && identityKeysFor({ email: `${local}@acme.com` }).length === 0);
}
for (const local of ["calendar", "invite", "events", "updates", "jane"]) {
  t.check(`${local}@ stays an email identity`, identityKeysFor({ email: `${local}@acme.com` }).length === 1);
}

console.log("names from identifiers");
const h = nameFromHandle("john.doe42");
t.check("john.doe42 → John Doe, confident", h?.full === "John Doe" && !h.weak, JSON.stringify(h));
t.check("j.smith is weak", nameFromHandle("j.smith")?.weak === true);
t.check("jsmith42 reads nothing", nameFromHandle("jsmith42") === null);
const display = nameFromEmail("jd@acme.com", "DOE, JANE");
t.check("a person's display name wins and is formatted", display?.full === "Jane Doe" && !display.weak, JSON.stringify(display));
t.check("a role display name falls back to the address", nameFromEmail("priya.raman@acme.com", "Acme Support")?.full === "Priya Raman");
t.check("a machine mailbox has no name", nameFromEmail("noreply@acme.com", "Jane Doe") === null);
t.check("a role mailbox with no person's name has none", nameFromEmail("info@acme.com", "") === null);
const slug = nameFromSlug("https://www.linkedin.com/in/john-smith-1a2b3c/");
t.check("a slug with a hash suffix → John Smith, confident", slug?.full === "John Smith" && !slug.weak, JSON.stringify(slug));
t.check("an encoded slug decodes", nameFromSlug("https://linkedin.com/in/jos%C3%A9-ruiz")?.full === "José Ruiz");
t.check("a vanity slug is weak", nameFromSlug("sfounder")?.weak === true);
t.check("a non-LinkedIn URL reads nothing", nameFromSlug("https://example.com/in/x") === null);

console.log("compareNames");
const rel: Array<[string, string, NameRelation]> = [
  ["Sarah Chen", "sarah  chen", "same"],
  ["José Ruiz", "Jose Ruiz", "variant"],
  ["Chen Sarah", "Sarah Chen", "variant"],
  ["Mike Torres", "Michael Torres", "variant"],
  ["M. Torres", "Michael Torres", "variant"],
  ["Michael J Torres", "Michael Torres", "variant"],
  ["Bob", "Rob", "variant"],
  ["Mike", "Michael Torres", "first_only"],
  ["Sarah", "Sarah Chen", "first_only"],
  ["Jon Smtih", "Jon Smith", "typo"],
  ["Sarah Chen", "Sarah Lee", "different"],
  ["Sarah", "Priya Raman", "different"],
];
for (const [a, b, want] of rel) t.check(`"${a}" ~ "${b}" → ${want}`, compareNames(a, b) === want, compareNames(a, b));
t.check("Samuel and Samantha are not one given name", !sameGivenName("Samuel", "Samantha"));
t.check("Jon and John are", sameGivenName("Jon", "John"));

console.log("shouldReplaceName");
t.check("Sarah → Sarah Chen", shouldReplaceName("Sarah", "Sarah Chen"));
t.check("never shrinks: Sarah Chen ← Sarah", !shouldReplaceName("Sarah Chen", "Sarah"));
t.check("never swaps: Michael Torres ← Mike Torres", !shouldReplaceName("Michael Torres", "Mike Torres"));
t.check("never another person: Sarah ← Priya Raman", !shouldReplaceName("Sarah", "Priya Raman"));
t.check("replaces a handle", shouldReplaceName("sarahc92", "Sarah Chen"));
t.check("replaces an address", shouldReplaceName("sarah@x.com", "Sarah Chen"));
t.check("replaces a placeholder", shouldReplaceName("LinkedIn contact", "Sarah Chen"));
t.check("fills an empty name", shouldReplaceName("", "Sarah Chen"));
t.check("cases an uncased name", shouldReplaceName("sarah chen", "Sarah Chen"));
t.check("never with a non-person", !shouldReplaceName("sarahc92", "Acme Inc"));
t.check("never a confirmed name", !shouldReplaceName("sarahc92", "Sarah Chen", { confirmed: true }));

t.done("names smoke tests");
