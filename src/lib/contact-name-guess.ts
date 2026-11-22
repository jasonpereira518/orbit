/**
 * Real names for contacts saved under a handle: "jsmith42", "john.doe", "jdoe_dev", or the
 * whole address. Imports name a person whatever the source called them, and a calendar guest
 * or an email sender with no display name arrives as their address.
 *
 * Pure: no database, no network. The reading rules live in `@/lib/names`; this file is the
 * guess order and the stored `name_guess` shape. The sweep (`@/lib/contact-name-sweep`) feeds
 * it the user's own address book and asks a model only when nothing here reads the handle.
 */
import { isHandle, PLACEHOLDER_NAMES } from "@/lib/names/classify";
import { nameFromHandle, nameFromSlug, type GuessedName } from "@/lib/names/from-identifier";
import { nameKey } from "@/lib/names/key";

export { isHandle, type GuessedName };

/** `user`: the person typed or confirmed this name; final for every automated writer. */
export type NameGuessSource = "address_book" | "linkedin" | "handle" | "ai" | "none" | "user";

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

/** Lower-cased email → the name the user's own Google or Outlook address book gives it. */
export type ProviderNameIndex = Map<string, GuessedName>;

/**
 * Checks whether a contact's stored name is really a username, handle, email prefix,
 * LinkedIn slug artifact, or generic placeholder, rather than an actual person name.
 */
export function isUsernameOrGenericName(
  name: string | null | undefined,
  email?: string | null,
  linkedinUrl?: string | null
): boolean {
  const n = (name ?? "").trim();
  if (!n) return true;
  if (PLACEHOLDER_NAMES.has(nameKey(n))) return true;
  if (isHandle(n, email)) return true;

  // Exactly the LinkedIn slug (e.g. "satya-nadella-12345" or "satyanadella").
  const slug = linkedinUrl?.match(/linkedin\.com\/in\/([^/?#]+)/i)?.[1]?.toLowerCase();
  if (slug) {
    const cleanSlug = slug.replace(/[\s\-_.]/g, "");
    const cleanName = n.toLowerCase().replace(/[\s\-_.]/g, "");
    if (cleanSlug && (cleanName === cleanSlug || cleanName === slug)) return true;
  }

  // A social handle (@jason), or one long run with no space (a random string or an id).
  return n.startsWith("@") || (!/\s/.test(n) && n.length > 20);
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

  const linkedin = nameFromSlug(c.linkedinUrl);
  if (linkedin && !linkedin.weak) return { first: linkedin.first, last: linkedin.last, full: linkedin.full, source: "linkedin", weak: false };

  // The stored name first, then the address: "jsmith42" saved for john.doe@x.com reads as John Doe.
  const reads = [c.fullName, email ?? ""].filter(Boolean).map(nameFromHandle);
  const best = reads.find((r) => r && !r.weak) ?? reads.find(Boolean);
  return best ? { first: best.first, last: best.last, full: best.full, source: "handle", weak: best.weak } : null;
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
