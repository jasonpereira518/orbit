import type { Contact } from "@/db/schema";

/**
 * The columns duplicate detection actually reads.
 *
 * Deliberately not `Contact`: the index was typed on the full row, so every caller was
 * pulling each contact's `notes`, `aiSummary`, `keyFacts`, `sharedInterests`, and
 * `opportunities` across the wire — on every import invocation, including each
 * self-continuation — in order to compare six short strings.
 */
export type DuplicateSubject = Pick<
  Contact,
  "id" | "fullName" | "email" | "linkedinUrl" | "xHandle" | "company" | "title"
>;

/** Confidence at/above which a duplicate match is treated as an auto-merge, not just a hint. */
export const DUPLICATE_MERGE_CONFIDENCE = 0.85;

function normalize(s: string | null | undefined) {
  return (s || "").trim().toLowerCase();
}

/** Strip punctuation/accents-ish noise for fuzzy name compares. */
function normalizeName(s: string | null | undefined) {
  return normalize(s)
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function levenshtein(a: string, b: string) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  const prev = new Array(b.length + 1);
  const curr = new Array(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
    }
    for (let j = 0; j <= b.length; j++) prev[j] = curr[j];
  }
  return prev[b.length];
}

/** 0–1 similarity from edit distance; short names need near-exact match. */
export function nameSimilarity(a: string | null | undefined, b: string | null | undefined) {
  const left = normalizeName(a);
  const right = normalizeName(b);
  if (!left || !right) return 0;
  if (left === right) return 1;
  const maxLen = Math.max(left.length, right.length);
  if (maxLen < 4) return 0;
  const distance = levenshtein(left, right);
  return Math.max(0, 1 - distance / maxLen);
}

export function linkedinSlug(url: string | null | undefined) {
  if (!url) return "";
  const match = url.match(/linkedin\.com\/in\/([^/?#]+)/i);
  return match ? match[1].toLowerCase() : normalize(url);
}

/**
 * Reduce anything that identifies an X/Twitter account to a bare lowercase
 * handle: a full profile URL on either domain, an "@handle", or a bare handle.
 * Returns "" when the input isn't a usable handle, so callers can treat empty
 * as "no signal" rather than matching everything together.
 *
 * Mirrored byte-for-byte in the extension's `extension/src/inject/dom/url.ts`;
 * change both together.
 */
export function normalizeXHandle(value: string | null | undefined) {
  if (!value) return "";
  const trimmed = value.trim();
  const fromUrl = trimmed.match(
    /(?:^|\/\/|\.)(?:x|twitter)\.com\/(?:#!\/)?@?([A-Za-z0-9_]{1,15})(?:[/?#]|$)/i
  );
  const raw = fromUrl ? fromUrl[1] : trimmed.replace(/^@/, "");
  return /^[A-Za-z0-9_]{1,15}$/.test(raw) ? raw.toLowerCase() : "";
}

/**
 * Generic over `T` (defaulting to `DuplicateSubject`) so a caller that still has full
 * `Contact` rows in hand (e.g. `calendar-sync.ts`, which reads fields duplicate detection
 * itself never touches) gets `contact: Contact` back, while a caller that queried only the
 * six columns gets `contact: DuplicateSubject` — no cast needed on either side.
 */
export type DuplicateMatch<T extends DuplicateSubject = DuplicateSubject> = {
  contact: T;
  reason: string;
  confidence: number;
};

export function findDuplicateCandidates<T extends DuplicateSubject>(
  existing: T[],
  incoming: {
    fullName?: string | null;
    email?: string | null;
    linkedinUrl?: string | null;
    xHandle?: string | null;
    company?: string | null;
    title?: string | null;
  }
): DuplicateMatch<T>[] {
  const matches: DuplicateMatch<T>[] = [];
  const name = normalize(incoming.fullName);
  const email = normalize(incoming.email);
  const linkedin = linkedinSlug(incoming.linkedinUrl);
  const xHandle = normalizeXHandle(incoming.xHandle);
  const company = normalize(incoming.company);
  const title = normalize(incoming.title);

  for (const contact of existing) {
    if (linkedin && linkedinSlug(contact.linkedinUrl) === linkedin) {
      matches.push({ contact, reason: "Same LinkedIn URL", confidence: 0.98 });
      continue;
    }
    if (xHandle && normalizeXHandle(contact.xHandle) === xHandle) {
      matches.push({ contact, reason: "Same X handle", confidence: 0.97 });
      continue;
    }
    if (email && normalize(contact.email) === email) {
      matches.push({ contact, reason: "Same email", confidence: 0.95 });
      continue;
    }
    if (
      name &&
      normalize(contact.fullName) === name &&
      company &&
      normalize(contact.company) === company
    ) {
      matches.push({ contact, reason: "Same name + company", confidence: 0.9 });
      continue;
    }
    if (
      name &&
      normalize(contact.fullName) === name &&
      title &&
      normalize(contact.title) === title
    ) {
      matches.push({ contact, reason: "Same name + title", confidence: 0.85 });
      continue;
    }
    if (name && normalize(contact.fullName) === name) {
      matches.push({ contact, reason: "Same full name", confidence: 0.6 });
      continue;
    }

    // Fuzzy name: only when company or title also aligns (avoids false merges).
    const fuzzy = nameSimilarity(incoming.fullName, contact.fullName);
    if (fuzzy >= 0.88) {
      const sameCompany =
        company && company === normalize(contact.company);
      const sameTitle = title && title === normalize(contact.title);
      if (sameCompany) {
        matches.push({
          contact,
          reason: "Similar name + company",
          confidence: 0.87,
        });
      } else if (sameTitle) {
        matches.push({
          contact,
          reason: "Similar name + title",
          confidence: 0.85,
        });
      }
    }
  }

  return matches.sort((a, b) => b.confidence - a.confidence);
}

/**
 * Precomputed lookup structure over an existing-contacts list, built once and
 * reused across many `findDuplicateCandidatesIndexed` calls. Exact-tier
 * matches (LinkedIn URL, email, name+company, name+title, name) become O(1)
 * map lookups instead of an O(existing.length) scan per row; only the fuzzy
 * fallback still scans, and only within a same-first-3-letters name bucket.
 */
export type DuplicateIndex = {
  byLinkedin: Map<string, DuplicateSubject[]>;
  byX: Map<string, DuplicateSubject[]>;
  byEmail: Map<string, DuplicateSubject[]>;
  byNameCompany: Map<string, DuplicateSubject[]>;
  byNameTitle: Map<string, DuplicateSubject[]>;
  byName: Map<string, DuplicateSubject[]>;
  fuzzyBuckets: Map<string, DuplicateSubject[]>;
};

function pushTo<K>(map: Map<K, DuplicateSubject[]>, key: K, contact: DuplicateSubject) {
  const list = map.get(key);
  if (list) list.push(contact);
  else map.set(key, [contact]);
}

/**
 * Join two normalized fields into one Map key. The separator is ASCII Unit Separator,
 * written as an escape (never a literal control byte) so it stays visible in source and
 * greppable — a literal NUL here once made this whole file read as binary to grep. It's
 * a character no real name/company/title contains, so `("Ada Lovelace", "Corp")` cannot
 * collide with `("Ada", "Lovelace Corp")` the way a space separator would. Every producer
 * and consumer of these keys must go through this function.
 */
function compositeKey(a: string, b: string) {
  return `${a}\u001f${b}`;
}

function fuzzyBucketKey(fullName: string | null | undefined) {
  return normalizeName(fullName).slice(0, 3);
}

export function buildDuplicateIndex(existing: DuplicateSubject[]): DuplicateIndex {
  const index: DuplicateIndex = {
    byLinkedin: new Map(),
    byX: new Map(),
    byEmail: new Map(),
    byNameCompany: new Map(),
    byNameTitle: new Map(),
    byName: new Map(),
    fuzzyBuckets: new Map(),
  };

  for (const contact of existing) {
    const name = normalize(contact.fullName);
    const email = normalize(contact.email);
    const linkedin = linkedinSlug(contact.linkedinUrl);
    const xHandle = normalizeXHandle(contact.xHandle);
    const company = normalize(contact.company);
    const title = normalize(contact.title);

    if (linkedin) pushTo(index.byLinkedin, linkedin, contact);
    if (xHandle) pushTo(index.byX, xHandle, contact);
    if (email) pushTo(index.byEmail, email, contact);
    if (name && company) pushTo(index.byNameCompany, compositeKey(name, company), contact);
    if (name && title) pushTo(index.byNameTitle, compositeKey(name, title), contact);
    if (name) pushTo(index.byName, name, contact);
    pushTo(index.fuzzyBuckets, fuzzyBucketKey(contact.fullName), contact);
  }

  return index;
}

/** Add a single contact (e.g. one just created mid-batch) into an existing index. */
export function addToDuplicateIndex(index: DuplicateIndex, contact: DuplicateSubject) {
  const name = normalize(contact.fullName);
  const email = normalize(contact.email);
  const linkedin = linkedinSlug(contact.linkedinUrl);
  const xHandle = normalizeXHandle(contact.xHandle);
  const company = normalize(contact.company);
  const title = normalize(contact.title);

  if (linkedin) pushTo(index.byLinkedin, linkedin, contact);
  if (xHandle) pushTo(index.byX, xHandle, contact);
  if (email) pushTo(index.byEmail, email, contact);
  if (name && company) pushTo(index.byNameCompany, compositeKey(name, company), contact);
  if (name && title) pushTo(index.byNameTitle, compositeKey(name, title), contact);
  if (name) pushTo(index.byName, name, contact);
  pushTo(index.fuzzyBuckets, fuzzyBucketKey(contact.fullName), contact);
}

/** Same matching tiers/confidences as `findDuplicateCandidates`, using a prebuilt `DuplicateIndex`. */
export function findDuplicateCandidatesIndexed(
  index: DuplicateIndex,
  incoming: {
    fullName?: string | null;
    email?: string | null;
    linkedinUrl?: string | null;
    xHandle?: string | null;
    company?: string | null;
    title?: string | null;
  }
): DuplicateMatch[] {
  const name = normalize(incoming.fullName);
  const email = normalize(incoming.email);
  const linkedin = linkedinSlug(incoming.linkedinUrl);
  const xHandle = normalizeXHandle(incoming.xHandle);
  const company = normalize(incoming.company);
  const title = normalize(incoming.title);

  const matched = new Set<DuplicateSubject>();
  const matches: DuplicateMatch[] = [];

  const addAll = (contacts: DuplicateSubject[] | undefined, reason: string, confidence: number) => {
    for (const contact of contacts || []) {
      if (matched.has(contact)) continue;
      matched.add(contact);
      matches.push({ contact, reason, confidence });
    }
  };

  if (linkedin) addAll(index.byLinkedin.get(linkedin), "Same LinkedIn URL", 0.98);
  if (xHandle) addAll(index.byX.get(xHandle), "Same X handle", 0.97);
  if (email) addAll(index.byEmail.get(email), "Same email", 0.95);
  if (name && company)
    addAll(index.byNameCompany.get(compositeKey(name, company)), "Same name + company", 0.9);
  if (name && title)
    addAll(index.byNameTitle.get(compositeKey(name, title)), "Same name + title", 0.85);
  if (name) addAll(index.byName.get(name), "Same full name", 0.6);

  // Fuzzy fallback, scoped to the same first-3-letters bucket as the incoming name.
  const bucket = index.fuzzyBuckets.get(fuzzyBucketKey(incoming.fullName)) || [];
  for (const contact of bucket) {
    if (matched.has(contact)) continue;
    const fuzzy = nameSimilarity(incoming.fullName, contact.fullName);
    if (fuzzy < 0.88) continue;
    const sameCompany = company && company === normalize(contact.company);
    const sameTitle = title && title === normalize(contact.title);
    if (sameCompany) {
      matched.add(contact);
      matches.push({ contact, reason: "Similar name + company", confidence: 0.87 });
    } else if (sameTitle) {
      matched.add(contact);
      matches.push({ contact, reason: "Similar name + title", confidence: 0.85 });
    }
  }

  return matches.sort((a, b) => b.confidence - a.confidence);
}

export function daysAgo(date: Date | string | null | undefined) {
  if (!date) return Infinity;
  const d = typeof date === "string" ? new Date(date) : date;
  return Math.floor((Date.now() - d.getTime()) / (1000 * 60 * 60 * 24));
}
