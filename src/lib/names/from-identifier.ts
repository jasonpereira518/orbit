import { classifyMailbox, isPersonName } from "./classify";
import { formatPersonName } from "./parse";

/**
 * Names read off identifiers: an address, a LinkedIn slug, a username. Every reading says
 * whether it is `weak`, so a caller can store it with a "?" instead of as fact. `null` means
 * nothing here reads a name: store the bare handle and let the name sweep try harder.
 */

export type GuessedName = { first: string; last: string; full: string };
export type IdentifierName = GuessedName & { weak: boolean };

/** Pieces of a handle that are never part of anyone's name: "jdoe_dev", "the.real.jane". */
const NOT_NAME = new Set(
  "dev eng hq official real the mr ms mrs dr info work mail admin team hello contact me its im".split(" ")
);

const cap = (w: string) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase();

function named(parts: string[]): GuessedName {
  const words = parts.map(cap);
  return { first: words[0], last: words[words.length - 1], full: words.join(" ") };
}

/**
 * A handle or address local part read as a name. Confident only for exactly first + last of two
 * letters or more ("john.doe", "john_smith", "john.m.doe"); "j.smith" is weak and "jsmith42" none.
 */
export function nameFromHandle(handle: string | null | undefined): IdentifierName | null {
  const parts = (handle ?? "")
    .split("@")[0]
    .split(/[._\-+\s]+/)
    .map((p) => p.replace(/[^\p{L}]/gu, "").toLowerCase())
    .filter((p) => p && !NOT_NAME.has(p));
  if (parts.length === 3 && parts[1].length === 1) parts.splice(1, 1);
  if (parts.length < 2) return null;
  const weak = parts.length !== 2 || parts[0].length < 2 || parts[1].length < 2;
  return { ...named(parts), weak };
}

/**
 * The best name an address gives: its display name when that is a person's ("Jane Doe <jd@x>",
 * "DOE, JANE"), else its local part. Null for a machine or role mailbox with no person's name.
 */
export function nameFromEmail(email: string | null | undefined, displayName?: string | null): IdentifierName | null {
  const mailbox = classifyMailbox(email);
  if (mailbox === "machine") return null;
  const shown = formatPersonName(displayName);
  if (shown && isPersonName(shown.fullName, { email })) {
    return { first: shown.firstName ?? shown.fullName, last: shown.lastName ?? "", full: shown.fullName, weak: false };
  }
  if (mailbox !== "person") return null;
  return nameFromHandle(email);
}

/**
 * The name to store for a record a source handed over: the source's name when it is a
 * person's (formatted), else a confident reading of the address or LinkedIn slug, else the
 * raw name or handle as-is — a handle on file is what the name sweep (`contact-name-sweep.ts`)
 * looks for, so storing it beats storing a guess with no "?" or a word like "Contact".
 * "" only when the record carries nothing at all.
 */
export function displayNameFor(r: { name?: string | null; email?: string | null; linkedinUrl?: string | null }): string {
  const shown = formatPersonName(r.name);
  if (shown && isPersonName(shown.fullName, { email: r.email })) return shown.fullName;
  const read = [nameFromEmail(r.email, r.name), nameFromSlug(r.linkedinUrl)].find((n) => n && !n.weak);
  if (read) return read.full;
  return r.name?.trim() || (r.email ? r.email.trim().split("@")[0] : "");
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
  while (tokens.length > 1 && isDisambiguator(tokens[tokens.length - 1])) {
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

/**
 * A LinkedIn URL or bare slug read as a name. Confident for two or more letter-only words
 * (`/in/john-smith-1a2b3c` → John Smith); a vanity handle (`sfounder`, `jsmith42`) is weak.
 */
export function nameFromSlug(urlOrSlug: string | null | undefined): IdentifierName | null {
  const input = urlOrSlug ?? "";
  const raw = input.match(/linkedin\.com\/(?:in|pub)\/([^/?#\s]+)/i)?.[1] ?? (/[/:]/.test(input) ? "" : input);
  if (!raw) return null;
  let slug = raw;
  try {
    slug = decodeURIComponent(raw);
  } catch {
    // A malformed escape; read the slug as written.
  }
  const full = personNameFromSlug(slug);
  if (!full || !/\p{L}/u.test(full)) return null;
  const words = full.split(" ");
  const weak = words.length < 2 || !words.every((w) => /^\p{L}+$/u.test(w));
  if (!weak) return { ...named(words), weak };
  return { first: words[0], last: words.length > 1 ? words[words.length - 1] : "", full, weak };
}
