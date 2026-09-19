/**
 * Logging a person by pasting their LinkedIn URL.
 *
 * Everything here is pure and free of runtime imports so the capture panel — a client
 * component — can run the same detection the server does. Nothing in this file may reach
 * `@/db`, directly or transitively, or the client bundle fails to chunk with a `node:fs`
 * error that names neither file. The one import is type-only, and therefore erased.
 *
 * The canonical URL built here (`https://www.linkedin.com/in/<slug>`) reduces to exactly
 * the value `linkedinSlug` in lib/duplicates.ts produces, so dedupe, contact_identities and
 * this path all agree on one spelling of a profile rather than three.
 */
import type { ParsedNote } from "@/lib/ai";

/** One profile URL found in pasted text. */
export type LinkedInProfileRef = {
  /** Canonical `https://www.linkedin.com/in/<slug>`. */
  url: string;
  slug: string;
};

/**
 * A pasted profile after lookup. `source` says how much to trust the fields: `apollo`
 * means a real profile match, `url` means everything but the URL was guessed from the
 * slug — which the review card flags rather than presenting as fact.
 */
export type PastedLinkedInPerson = {
  url: string;
  slug: string;
  name: string | null;
  title: string | null;
  company: string | null;
  location: string | null;
  school: string | null;
  email: string | null;
  source: "apollo" | "url";
};

/**
 * How many pasted profiles one capture will look up. Past this the paste is almost
 * certainly an exported list, which belongs in Imports where it can be resumed — and each
 * profile past the cap is a paid Apollo credit spent on a guess.
 */
export const MAX_PASTED_LINKEDIN_PROFILES = 10;

/**
 * `linkedin.com/in/<slug>` on any host LinkedIn serves profiles from — `www.`, a country
 * subdomain (`ca.`, `uk.`), or the bare domain a user typed by hand. The slug stops at
 * whitespace or any character that cannot appear in one, which is what lets a URL sitting
 * mid-sentence ("met sarah (linkedin.com/in/sarah-chen), sharp") come out clean.
 */
const PROFILE_URL_RE =
  /(?:https?:\/\/)?(?:[a-z0-9-]+\.)?linkedin\.com\/in\/([^\s/?#"'<>,;)\]}]+)/gi;

export function canonicalLinkedInUrl(slug: string) {
  return `https://www.linkedin.com/in/${slug}`;
}

/**
 * Normalize one raw slug: percent-decode it (LinkedIn encodes non-ASCII names), drop
 * trailing punctuation a sentence left attached, and lowercase it so the same profile
 * pasted twice in different casing is one person.
 */
function normalizeSlug(raw: string): string | null {
  let slug = raw.trim();
  try {
    slug = decodeURIComponent(slug);
  } catch {
    // A stray `%` that isn't an escape — keep the raw form rather than losing the profile.
  }
  slug = slug.replace(/[.,;:!?]+$/, "").trim();
  if (!slug) return null;
  return slug.toLowerCase();
}

/** Every distinct LinkedIn profile URL in a block of text, in the order pasted. */
export function extractLinkedInProfileRefs(text: string): LinkedInProfileRef[] {
  if (!text.trim()) return [];
  const out: LinkedInProfileRef[] = [];
  const seen = new Set<string>();

  PROFILE_URL_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = PROFILE_URL_RE.exec(text))) {
    const slug = normalizeSlug(match[1] ?? "");
    if (!slug || seen.has(slug)) continue;
    seen.add(slug);
    out.push({ slug, url: canonicalLinkedInUrl(slug) });
  }
  return out;
}

/**
 * True when the paste is nothing but profile URLs — one, or a list of them.
 *
 * This is what lets "paste a URL, get a person" skip the model entirely: there is no prose
 * for it to read, so the AI pass would be a round-trip and a charge to learn nothing. Only
 * separators may remain once the URLs are removed; a single word of context ("Sarah —
 * linkedin.com/in/…") means the note is prose and goes through the normal parse.
 */
export function isLinkedInOnlyPaste(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  if (!extractLinkedInProfileRefs(trimmed).length) return false;

  PROFILE_URL_RE.lastIndex = 0;
  const remainder = trimmed.replace(PROFILE_URL_RE, " ");
  // Separators people actually paste between URLs: whitespace, commas, semicolons,
  // bullets, dashes, and the numbering a copied list brings with it.
  return !/[^\s,;•\-–—*·|\d.)\]]/u.test(remainder);
}

/**
 * A token that disambiguates a slug rather than naming anyone: LinkedIn's trailing hash
 * (`8b1a2b34`), or a year someone added to claim a taken handle.
 */
function isDisambiguator(token: string) {
  // Any trailing run of digits, however short: LinkedIn hands out `john-smith-3` as
  // readily as `john-smith-1986`, and no name ends in a number.
  if (/^\d+$/.test(token)) return true;
  if (token.length < 4) return false;
  if (/^[0-9a-f]{6,}$/i.test(token)) return true;
  // Mixed letters and digits with no vowel pattern to speak of — `a1b2c3`, `x7f2ab9`.
  return /^(?=.*[a-z])(?=.*\d)[a-z0-9]+$/i.test(token);
}

/**
 * Best guess at a person's name from their profile slug, for when no profile lookup is
 * available. `sarah-chen-8b1a2b34` → `Sarah Chen`.
 *
 * This is a guess and is labelled as one everywhere it surfaces: slugs drop apostrophes and
 * capitals (`patrick-obrien`), and a vanity handle carries no name at all (`sfounder`). The
 * review card puts it in an editable field with a low-confidence marker, so the cost of a
 * wrong guess is one correction rather than a wrong contact.
 */
export function personNameFromSlug(slug: string): string | null {
  const tokens = slug
    .split(/[-_.]+/)
    .map((t) => t.trim())
    .filter(Boolean);
  if (!tokens.length) return null;

  // Only trailing disambiguators go — a leading digit run is part of however they spell
  // their name, and dropping from the middle would reorder a name we cannot read anyway.
  while (tokens.length > 1 && isDisambiguator(tokens[tokens.length - 1]!)) {
    tokens.pop();
  }

  const name = tokens
    .map((token) =>
      // A slug that already carries capitals was typed that way; leave it alone rather
      // than flattening `McKinsey` into `Mckinsey`.
      /[A-Z]/.test(token)
        ? token
        : token.charAt(0).toUpperCase() + token.slice(1)
    )
    .join(" ")
    .trim();

  return name || null;
}

/** The lines a resolved profile contributes, as the person would read them. */
export function linkedInPersonFactLines(person: PastedLinkedInPerson): string[] {
  const lines: string[] = [];
  if (person.name) lines.push(`Name: ${person.name}`);
  if (person.title) lines.push(`Role: ${person.title}`);
  if (person.company) lines.push(`Company: ${person.company}`);
  if (person.location) lines.push(`Location: ${person.location}`);
  if (person.school) lines.push(`School: ${person.school}`);
  if (person.email) lines.push(`Email: ${person.email}`);
  lines.push(`LinkedIn: ${person.url}`);
  return lines;
}

/**
 * The block folded into the corpus when profile URLs are pasted *alongside* prose, so the
 * model attributes a role and a company to the right person instead of inventing them or
 * leaving the URL as the only thing it knows.
 */
export function linkedInFactsBlock(people: PastedLinkedInPerson[]): string {
  if (!people.length) return "";
  const blocks = people.map((p) => linkedInPersonFactLines(p).join("\n"));
  return `LinkedIn profiles referenced in these notes:\n\n${blocks.join("\n\n")}`;
}

/** The note body stored on the interaction for a profile logged from a bare URL. */
export function linkedInOnlyNoteText(person: PastedLinkedInPerson): string {
  const facts = linkedInPersonFactLines(person).join("\n");
  return `Added from a LinkedIn profile.\n\n${facts}`;
}

/**
 * Shape a resolved profile as a `ParsedNote`, so a pasted URL reaches the review card and
 * the save path through exactly the same structure an AI-parsed person does. No second
 * write path, and no field the reviewer cannot edit before it is saved.
 */
export function parsedNoteFromLinkedInPerson(
  person: PastedLinkedInPerson
): ParsedNote {
  const guessed = person.source === "url";
  return {
    name: person.name,
    company: person.company,
    role: person.title,
    presence: "participant",
    location: person.location,
    email: person.email,
    linkedin_url: person.url,
    met_at: null,
    topics: [],
    action_items: [],
    follow_up_recommendation: null,
    follow_up_days: null,
    relationship_score_suggestion: null,
    tags: [],
    summary: null,
    key_facts: person.school ? [`Studied at ${person.school}`] : [],
    opportunities: [],
    shared_interests: [],
    suggested_next_message: null,
    // A profile match is a fact about the person; a slug is a reading of a URL. The card
    // surfaces the difference rather than letting a guessed name look confirmed.
    confidence: guessed ? 0.4 : 0.9,
    interaction_date: null,
    low_confidence_fields: guessed && person.name ? ["name"] : [],
  };
}
