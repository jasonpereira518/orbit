/**
 * "Log a person by pasting their LinkedIn URL" rests entirely on reading a URL correctly:
 * which text counts as a profile link, whether a paste is URLs alone (and so skips the
 * model), and what name a slug yields when no profile lookup is available.
 *
 * All pure — no DB, no AI, no network. The Apollo half lives in lib/linkedin-capture.ts and
 * is exercised against the real API, not here.
 *
 * Run: npx tsx scripts/smoke-linkedin-paste.ts
 */
import {
  canonicalLinkedInUrl,
  extractLinkedInProfileRefs,
  isLinkedInOnlyPaste,
  linkedInFactsBlock,
  personNameFromSlug,
  parsedNoteFromLinkedInPerson,
  type PastedLinkedInPerson,
} from "../src/lib/linkedin-paste";
import { linkedinSlug } from "../src/lib/duplicates";

let failures = 0;

function check(label: string, condition: boolean, detail?: string) {
  if (condition) {
    console.log(`  ok  ${label}`);
    return;
  }
  failures += 1;
  console.log(`  FAIL ${label}${detail ? `: ${detail}` : ""}`);
}

function slugs(text: string) {
  return extractLinkedInProfileRefs(text).map((r) => r.slug);
}

console.log("\nextractLinkedInProfileRefs");
{
  check(
    "bare host, no scheme",
    slugs("linkedin.com/in/sarah-chen").join() === "sarah-chen"
  );
  check(
    "https + www",
    slugs("https://www.linkedin.com/in/sarah-chen").join() === "sarah-chen"
  );
  check(
    "country subdomain",
    slugs("https://ca.linkedin.com/in/sarah-chen").join() === "sarah-chen"
  );
  check(
    "trailing slash and query string",
    slugs("https://www.linkedin.com/in/sarah-chen/?originalSubdomain=ca")
      .join() === "sarah-chen"
  );
  check(
    "mid-sentence, parenthesised, comma after",
    slugs("met sarah (linkedin.com/in/sarah-chen), sharp on evals").join() ===
      "sarah-chen"
  );
  check(
    "sentence-ending period is not part of the slug",
    slugs("Her profile is linkedin.com/in/sarah-chen.").join() === "sarah-chen"
  );
  check(
    "several profiles keep paste order",
    slugs(
      "linkedin.com/in/sarah-chen\nlinkedin.com/in/marcus-lee\nlinkedin.com/in/priya-nair"
    ).join() === "sarah-chen,marcus-lee,priya-nair"
  );
  check(
    "same profile twice, different casing, is one person",
    slugs(
      "https://www.linkedin.com/in/Sarah-Chen and linkedin.com/in/sarah-chen"
    ).length === 1
  );
  check(
    "percent-encoded non-ASCII slug decodes",
    slugs("linkedin.com/in/jos%C3%A9-p%C3%A9rez").join() === "josé-pérez"
  );
  // A company page is not a person. Logging one as a contact would create a contact named
  // after a company, which is exactly the kind of junk row dedupe cannot undo.
  check(
    "company pages are not profiles",
    slugs("https://www.linkedin.com/company/stripe").length === 0
  );
  check(
    "feed and job URLs are not profiles",
    slugs("linkedin.com/feed/ linkedin.com/jobs/view/123").length === 0
  );
  check("empty text yields nothing", slugs("   ").length === 0);
}

console.log("\nisLinkedInOnlyPaste — takes the no-model path");
{
  check("one bare URL", isLinkedInOnlyPaste("https://www.linkedin.com/in/sarah-chen"));
  check(
    "URL with surrounding whitespace",
    isLinkedInOnlyPaste("\n  linkedin.com/in/sarah-chen  \n")
  );
  check(
    "newline-separated list",
    isLinkedInOnlyPaste(
      "linkedin.com/in/sarah-chen\nlinkedin.com/in/marcus-lee"
    )
  );
  check(
    "comma-separated list",
    isLinkedInOnlyPaste(
      "linkedin.com/in/sarah-chen, linkedin.com/in/marcus-lee"
    )
  );
  check(
    "numbered list from a copied doc",
    isLinkedInOnlyPaste(
      "1. linkedin.com/in/sarah-chen\n2. linkedin.com/in/marcus-lee"
    )
  );
  check(
    "bulleted list",
    isLinkedInOnlyPaste(
      "- linkedin.com/in/sarah-chen\n- linkedin.com/in/marcus-lee"
    )
  );
}

console.log("\nisLinkedInOnlyPaste — falls through to the model");
{
  // One word of context is a note, and a note is worth reading: the model gets how they
  // met and what was said, which the URL cannot supply.
  check(
    "a name alongside the URL is prose",
    !isLinkedInOnlyPaste("Sarah Chen — linkedin.com/in/sarah-chen")
  );
  check(
    "notes with a URL buried in them are prose",
    !isLinkedInOnlyPaste(
      "AWS Summit. Met Sarah (linkedin.com/in/sarah-chen), talked evals."
    )
  );
  check("no URL at all", !isLinkedInOnlyPaste("Met Sarah Chen at AWS Summit"));
  check("empty", !isLinkedInOnlyPaste("   "));
}

console.log("\npersonNameFromSlug");
{
  check(
    "plain two-part slug",
    personNameFromSlug("sarah-chen") === "Sarah Chen"
  );
  check(
    "LinkedIn's trailing hash is dropped",
    personNameFromSlug("sarah-chen-8b1a2b34") === "Sarah Chen"
  );
  check(
    "a trailing year is a disambiguator, not a name",
    personNameFromSlug("marcus-lee-1986") === "Marcus Lee"
  );
  // The LinkedIn messages importer shares this rule and has always dropped a short
  // trailing digit — `john-smith-3` is the commonest shape LinkedIn hands out.
  check(
    "a single trailing digit goes too",
    personNameFromSlug("john-smith-3") === "John Smith"
  );
  check(
    "three real name parts survive",
    personNameFromSlug("maria-del-carmen") === "Maria Del Carmen"
  );
  check(
    "a short trailing token is kept — it could be a suffix",
    personNameFromSlug("john-smith-jr") === "John Smith Jr"
  );
  check(
    "existing capitals are left alone",
    personNameFromSlug("McKinsey-Alumni") === "McKinsey-Alumni".split("-").join(" ")
  );
  check(
    "a vanity handle still yields something to edit",
    personNameFromSlug("sfounder") === "Sfounder"
  );
  // Stripping every token would leave an unnamed person, which the action rejects; the
  // guess has to stop before that.
  check(
    "an all-hash slug keeps its last token rather than emptying",
    personNameFromSlug("8b1a2b34") === "8b1a2b34"
  );
  check("empty slug", personNameFromSlug("") === null);
}

console.log("\none canonical spelling of a profile");
{
  // The URL this path writes onto a contact must reduce to the same value dedupe and
  // contact_identities index on, or the same person pasted and imported becomes two rows.
  for (const slug of ["sarah-chen", "sarah-chen-8b1a2b34", "josé-pérez"]) {
    check(
      `linkedinSlug round-trips ${slug}`,
      linkedinSlug(canonicalLinkedInUrl(slug)) === slug,
      linkedinSlug(canonicalLinkedInUrl(slug))
    );
  }
}

const apolloPerson: PastedLinkedInPerson = {
  url: canonicalLinkedInUrl("sarah-chen"),
  slug: "sarah-chen",
  name: "Sarah Chen",
  title: "Partnerships Lead",
  company: "OpenAI",
  location: "San Francisco, CA",
  school: "Berkeley",
  email: "sarah@example.com",
  source: "apollo",
};

const guessedPerson: PastedLinkedInPerson = {
  url: canonicalLinkedInUrl("marcus-lee-1986"),
  slug: "marcus-lee-1986",
  name: "Marcus Lee",
  title: null,
  company: null,
  location: null,
  school: null,
  email: null,
  source: "url",
};

console.log("\nparsedNoteFromLinkedInPerson");
{
  const parsed = parsedNoteFromLinkedInPerson(apolloPerson);
  check("carries the canonical URL", parsed.linkedin_url === apolloPerson.url);
  check("role maps to the contact's title field", parsed.role === "Partnerships Lead");
  check("school lands in key facts", parsed.key_facts.join() === "Studied at Berkeley");
  check("presence is participant, so it gets a review card", parsed.presence === "participant");
  check("a real match is not flagged low-confidence", parsed.low_confidence_fields.length === 0);
  check("a real match is confident", (parsed.confidence ?? 0) >= 0.85);

  const guessed = parsedNoteFromLinkedInPerson(guessedPerson);
  // The whole safety of the no-lookup path is that a guessed name is labelled as one —
  // the review card highlights `low_confidence_fields` in an editable input.
  check(
    "a slug-derived name is flagged for review",
    guessed.low_confidence_fields.join() === "name"
  );
  check("a slug-derived name is not confident", (guessed.confidence ?? 1) < 0.5);
  check("nothing is invented for missing fields", guessed.company === null && guessed.role === null);
}

console.log("\nlinkedInFactsBlock");
{
  const block = linkedInFactsBlock([apolloPerson, guessedPerson]);
  check("names the source", block.startsWith("LinkedIn profiles referenced"));
  check("includes both profiles' URLs", block.includes(apolloPerson.url) && block.includes(guessedPerson.url));
  check("includes looked-up role and company", block.includes("Role: Partnerships Lead") && block.includes("Company: OpenAI"));
  check("omits fields nobody supplied", !block.includes("Role: null"));
  check("empty input yields no block", linkedInFactsBlock([]) === "");
}

if (failures > 0) {
  console.log(`\n${failures} check(s) failed\n`);
  process.exit(1);
}
console.log("\nAll LinkedIn paste checks passed\n");
process.exit(0);
