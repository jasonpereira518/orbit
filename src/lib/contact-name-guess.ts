/**
 * Real names for contacts saved under a handle: "jsmith42", "john.doe", "jdoe_dev", or the
 * whole address. Imports name a person whatever the source called them, and a calendar guest
 * or an email sender with no display name arrives as their address.
 *
 * Pure: no database, no network. The sweep (`@/lib/contact-name-sweep`) feeds it the user's
 * own address book and asks a model only when nothing here reads the handle confidently.
 */

export type NameGuessSource = "address_book" | "linkedin" | "handle" | "ai" | "none";

/** Stored on `contacts.name_guess`. `weak` puts a "?" by the name until someone settles it. */
export type NameGuess = {
  /** The name before Orbit changed it: the handle. */
  from: string;
  source: NameGuessSource;
  weak: boolean;
  /** ISO time it was written. */
  at: string;
};

/**
 * The guess to ask about, when the name shown is the guessed one: a preferred name hides it.
 * Server pages call this so only weak guesses reach the client.
 */
export function openNameGuess(c: { preferredName?: string | null; nameGuess?: NameGuess | null }): NameGuess | null {
  return !c.preferredName?.trim() && c.nameGuess?.weak ? c.nameGuess : null;
}

export type GuessedName = { first: string; last: string; full: string };

/** Lower-cased email → the name the user's own Google or Outlook address book gives it. */
export type ProviderNameIndex = Map<string, GuessedName>;

/** A stored name that is really an address handle: "", "dmcraver" for dmcraver@…, "calvintwong25". */
export function isHandle(name: string | null | undefined, email?: string | null): boolean {
  const n = (name ?? "").trim();
  if (!n) return true;
  if (email && n.toLowerCase() === email.split("@")[0]?.toLowerCase()) return true;
  return !/\s/.test(n) && /[\d._@]/.test(n);
}

/** Pieces of a handle that are never part of anyone's name: "jdoe_dev", "the.real.jane". */
const NOT_NAME = new Set(
  "dev eng hq official real the mr ms mrs dr info work mail admin team hello contact me its im".split(" ")
);

const cap = (w: string) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase();

function named(parts: string[]): GuessedName {
  const words = parts.map(cap);
  return { first: words[0]!, last: words[words.length - 1]!, full: words.join(" ") };
}

/** "john.doe42" → ["john", "doe"]; digits and non-name pieces dropped. */
function handleParts(handle: string): string[] {
  return handle
    .split("@")[0]!
    .split(/[._\-+\s]+/)
    .map((p) => p.replace(/[^\p{L}]/gu, "").toLowerCase())
    .filter((p) => p && !NOT_NAME.has(p));
}

/** "/in/john-smith-1a2b3c" → John Smith. Pieces with digits are LinkedIn's suffix, not a name. */
function nameFromLinkedin(url: string | null | undefined): GuessedName | null {
  const slug = url?.match(/linkedin\.com\/in\/([^/?#]+)/i)?.[1];
  if (!slug) return null;
  let decoded = slug;
  try {
    decoded = decodeURIComponent(slug);
  } catch {
    // A malformed escape; read the slug as written.
  }
  const parts = decoded
    .split("-")
    .filter((p) => /^\p{L}+$/u.test(p))
    .map((p) => p.toLowerCase());
  return parts.length >= 2 ? named(parts) : null;
}

/**
 * A handle read as a name. Confident only for exactly first + last of two letters or more
 * ("john.doe", "john_smith", "john.m.doe"); "j.smith" is a weak guess and "jsmith42" no guess.
 */
function nameFromHandle(handle: string): { name: GuessedName; weak: boolean } | null {
  const parts = handleParts(handle);
  if (parts.length === 3 && parts[1]!.length === 1) parts.splice(1, 1);
  if (parts.length < 2) return null;
  const weak = parts.length !== 2 || parts[0]!.length < 2 || parts[1]!.length < 2;
  return { name: named(parts), weak };
}

export type NameGuessResult = GuessedName & { source: NameGuessSource; weak: boolean };

/**
 * The best name Orbit can give a contact saved under a handle, or null when nothing here
 * reads it (the sweep then asks a model). Stops at the first confident source:
 * the user's address book, then the LinkedIn URL, then the handle itself.
 */
export function guessName(
  c: { fullName: string; email?: string | null; linkedinUrl?: string | null },
  index?: ProviderNameIndex
): NameGuessResult | null {
  const email = c.email?.trim().toLowerCase() || null;
  const book = email ? index?.get(email) : undefined;
  if (book && !isHandle(book.full)) return { ...book, source: "address_book", weak: false };

  const linkedin = nameFromLinkedin(c.linkedinUrl);
  if (linkedin) return { ...linkedin, source: "linkedin", weak: false };

  // The stored name first, then the address: "jsmith42" saved for john.doe@x.com reads as John Doe.
  const reads = [c.fullName, email ?? ""].filter(Boolean).map(nameFromHandle);
  const best = reads.find((r) => r && !r.weak) ?? reads.find(Boolean);
  return best ? { ...best.name, source: "handle", weak: best.weak } : null;
}

/** A model's `{first, last}` made safe to store as a name, or null. */
export function sanitizeGuessedName(first: unknown, last: unknown): GuessedName | null {
  const clean = (v: unknown) =>
    typeof v === "string" ? v.replace(/[^\p{L}' .-]/gu, "").replace(/\s+/g, " ").trim() : "";
  const f = clean(first);
  const l = clean(last);
  const full = [f, l].filter(Boolean).join(" ");
  if (!f || !/\p{L}{2}/u.test(full) || full.length > 40) return null;
  return { first: f, last: l, full };
}
