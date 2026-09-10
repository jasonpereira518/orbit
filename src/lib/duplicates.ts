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

/**
 * The line between "confident enough to merge on its own" and "ask a human".
 *
 * At or above it a match is folded automatically; below it the two contacts are both kept
 * and the pair becomes a `duplicate_suggestions` row for the review page. The tiers that
 * clear it are every identifier match plus name+company (0.90), name+title (0.85) and the
 * fuzzy variants (0.87/0.85). The only tier that does not is a bare full-name match at
 * 0.60 — two people genuinely can share a name and nothing else, so that one is a question,
 * not an answer.
 *
 * Merging on this threshold is safe in a way it was not before: `contact_merges` archives
 * the losing contact whole, so a wrong automatic merge is visible in the recent-merges list
 * and undoable. What this threshold must never do again is drop to 0.60 for a source that
 * creates contacts — calendar sync used to, which silently collapsed every pair of people
 * in a network who happened to share a full name.
 */
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

/**
 * MUST stay equal to the `linkedin_slug` generated column in `src/db/index.ts`
 * (`lower(split_part(linkedin_url, '/in/', 2) …)`) — the column and this function are two
 * spellings of one rule, and `contact_identities` rows are written from this one.
 */
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
 * Reduce a phone number to E.164 (`+` followed by digits), or "" when the input carries no
 * usable signal. Phone was previously normalized nowhere and matched on nothing.
 *
 * A bare 10-digit number is assumed NANP (`+1`), which is the only guess made here. That
 * guess can in principle collide a US number with a 10-digit number elsewhere sharing every
 * digit, and such a collision auto-merges two people. Merges are reversible, and the
 * alternative — keying on raw digits — over-merges strictly more (it would also collide
 * `+441234567890` with `01234567890`).
 */
export function normalizePhone(value: string | null | undefined) {
  if (!value) return "";
  const trimmed = value.trim();
  const hasPlus = trimmed.startsWith("+");
  const digits = trimmed.replace(/\D/g, "");
  if (!digits) return "";
  if (hasPlus) return digits.length >= 7 && digits.length <= 15 ? `+${digits}` : "";
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  if (digits.length === 10) return `+1${digits}`;
  // Anything else (extensions, partial numbers, unprefixed international) is ambiguous:
  // no key rather than a wrong one.
  return "";
}

/**
 * Mailbox local parts that belong to an organisation rather than a person. A shared inbox
 * is not an identity — without this, importing `info@acme.com` for three different people
 * at Acme would collapse all three into one contact, and the unique index on
 * `contact_identities` would make that collapse mandatory rather than merely likely.
 */
const ROLE_EMAIL_LOCALS = new Set([
  "info",
  "hello",
  "hi",
  "contact",
  "contactus",
  "admin",
  "support",
  "help",
  "sales",
  "team",
  "office",
  "mail",
  "email",
  "enquiries",
  "inquiries",
  "billing",
  "accounts",
  "accounting",
  "finance",
  "hr",
  "jobs",
  "careers",
  "recruiting",
  "press",
  "media",
  "marketing",
  "legal",
  "privacy",
  "security",
  "abuse",
  "postmaster",
  "webmaster",
  "noreply",
  "no-reply",
  "donotreply",
  "do-not-reply",
  "notifications",
  "newsletter",
  "subscriptions",
]);

/** True when an address identifies a mailbox rather than a person. */
export function isRoleEmail(value: string | null | undefined) {
  const email = normalize(value);
  const at = email.lastIndexOf("@");
  if (at <= 0) return false;
  const local = email.slice(0, at).replace(/\+.*$/, "");
  return ROLE_EMAIL_LOCALS.has(local);
}

/**
 * The identifier kinds strong enough to say "this is the same person" on their own. Each is
 * unique per user in `contact_identities`, which is what makes duplicate prevention
 * race-proof rather than best-effort.
 *
 * Conceptually the same precedence as the `li:`/`em:`/`hd:`/`nm:` prefixes in
 * `attendeeIdentityKey` (`src/lib/events/identity.ts`) and `participantIdentityKey`
 * (`src/lib/ingest/events.ts`), with two deliberate differences: there is no `nm:` kind here
 * (a name is never an identity *across* contacts, only within one event's roster), and every
 * available kind is emitted rather than only the strongest, because a contact owns all of
 * its identifiers at once.
 */
export const IDENTITY_KINDS = ["email", "linkedin_slug", "phone_e164", "x_handle"] as const;
export type IdentityKind = (typeof IDENTITY_KINDS)[number];

export type IdentityKey = { kind: IdentityKind; value: string };

export type IdentityInput = {
  email?: string | null;
  phone?: string | null;
  linkedinUrl?: string | null;
  xHandle?: string | null;
};

/**
 * Every strong identifier carried by a record, normalized. An empty array means "nothing
 * here identifies a person" — such a record can only ever be matched by name, and so can
 * only ever produce a review suggestion, never an automatic merge.
 *
 * Returned sorted by `(kind, value)`. That order is load-bearing at the call site: two
 * concurrent inserts touching the same two identities in opposite order deadlock on the
 * upsert's row locks.
 */
export function identityKeysFor(input: IdentityInput): IdentityKey[] {
  const keys: IdentityKey[] = [];
  const linkedin = linkedinSlug(input.linkedinUrl);
  if (linkedin) keys.push({ kind: "linkedin_slug", value: linkedin });
  const handle = normalizeXHandle(input.xHandle);
  if (handle) keys.push({ kind: "x_handle", value: handle });
  const email = normalize(input.email);
  if (email && email.includes("@") && !isRoleEmail(email)) {
    keys.push({ kind: "email", value: email });
  }
  const phone = normalizePhone(input.phone);
  if (phone) keys.push({ kind: "phone_e164", value: phone });
  return keys.sort((a, b) =>
    a.kind === b.kind ? (a.value < b.value ? -1 : 1) : a.kind < b.kind ? -1 : 1
  );
}

export type DuplicateMatch<T extends DuplicateSubject = DuplicateSubject> = {
  contact: T;
  reason: string;
  confidence: number;
  /**
   * True when the match came from a unique identifier rather than a name comparison.
   * Whether it MERGES is decided by `confidence` against `DUPLICATE_MERGE_CONFIDENCE`,
   * not by this.
   */
  strong: boolean;
};

/**
 * Precomputed lookup structure over an existing-contacts list, built once and
 * reused across many `findDuplicateCandidatesIndexed` calls. Exact-tier
 * matches (LinkedIn URL, email, name+company, name+title, name) become O(1)
 * map lookups instead of an O(existing.length) scan per row; only the fuzzy
 * fallback still scans, and only within same-first-3-letters name buckets.
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

/**
 * The fuzzy-scan buckets a name belongs to.
 *
 * Deliberately more than one. Bucketing on the first three letters of the *whole* name — as
 * this did originally — meant "Jon Smith" (`jon`) and "John Smith" (`joh`) never landed in
 * the same bucket, so the indexed matcher could not see a near-miss the old linear matcher
 * caught. Indexing under the first *and* last token's prefix means a typo in either half
 * still leaves the two names sharing a bucket.
 */
function fuzzyBucketKeys(fullName: string | null | undefined): string[] {
  const tokens = normalizeName(fullName).split(" ").filter(Boolean);
  if (!tokens.length) return [""];
  const keys = new Set<string>([tokens[0].slice(0, 3)]);
  if (tokens.length > 1) keys.add(tokens[tokens.length - 1].slice(0, 3));
  return [...keys];
}

function emptyIndex(): DuplicateIndex {
  return {
    byLinkedin: new Map(),
    byX: new Map(),
    byEmail: new Map(),
    byNameCompany: new Map(),
    byNameTitle: new Map(),
    byName: new Map(),
    fuzzyBuckets: new Map(),
  };
}

/**
 * Add a single contact (e.g. one just created mid-batch) into an existing index.
 *
 * `buildDuplicateIndex` is defined in terms of this rather than repeating the key
 * derivation: a past bug had the two computing composite keys with different separators,
 * which silently under-merged mid-batch contacts. One body cannot drift from itself.
 */
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
  for (const key of fuzzyBucketKeys(contact.fullName)) pushTo(index.fuzzyBuckets, key, contact);
}

export function buildDuplicateIndex(existing: DuplicateSubject[]): DuplicateIndex {
  const index = emptyIndex();
  for (const contact of existing) addToDuplicateIndex(index, contact);
  return index;
}

export type DuplicateProbe = {
  fullName?: string | null;
  email?: string | null;
  linkedinUrl?: string | null;
  xHandle?: string | null;
  company?: string | null;
  title?: string | null;
};

/**
 * The one matcher.
 *
 * There used to be a second, linear implementation of these same tiers. The two were not
 * equivalent — the linear one `continue`d after its first tier hit while this one collects
 * across tiers — so a preview and the write path that followed it could disagree about the
 * same row. Callers holding a small array should use `matchAgainst`, which builds a
 * throwaway index; callers matching many probes against one population must hoist
 * `buildDuplicateIndex` out of their loop.
 */
export function findDuplicateCandidatesIndexed(
  index: DuplicateIndex,
  incoming: DuplicateProbe
): DuplicateMatch[] {
  const name = normalize(incoming.fullName);
  const email = normalize(incoming.email);
  const linkedin = linkedinSlug(incoming.linkedinUrl);
  const xHandle = normalizeXHandle(incoming.xHandle);
  const company = normalize(incoming.company);
  const title = normalize(incoming.title);

  const matched = new Set<DuplicateSubject>();
  const matches: DuplicateMatch[] = [];

  const addAll = (
    contacts: DuplicateSubject[] | undefined,
    reason: string,
    confidence: number,
    strong: boolean
  ) => {
    for (const contact of contacts || []) {
      if (matched.has(contact)) continue;
      matched.add(contact);
      matches.push({ contact, reason, confidence, strong });
    }
  };

  if (linkedin) addAll(index.byLinkedin.get(linkedin), "Same LinkedIn URL", 0.98, true);
  if (xHandle) addAll(index.byX.get(xHandle), "Same X handle", 0.97, true);
  if (email) addAll(index.byEmail.get(email), "Same email", 0.95, true);
  if (name && company)
    addAll(
      index.byNameCompany.get(compositeKey(name, company)),
      "Same name + company",
      0.9,
      false
    );
  if (name && title)
    addAll(index.byNameTitle.get(compositeKey(name, title)), "Same name + title", 0.85, false);
  if (name) addAll(index.byName.get(name), "Same full name", 0.6, false);

  // Fuzzy fallback, scoped to the buckets the incoming name belongs to. A contact can sit in
  // two buckets, so `matched` (not a per-bucket set) is what keeps it to one match.
  for (const key of fuzzyBucketKeys(incoming.fullName)) {
    for (const contact of index.fuzzyBuckets.get(key) || []) {
      if (matched.has(contact)) continue;
      const fuzzy = nameSimilarity(incoming.fullName, contact.fullName);
      if (fuzzy < 0.88) continue;
      const sameCompany = company && company === normalize(contact.company);
      const sameTitle = title && title === normalize(contact.title);
      if (sameCompany) {
        matched.add(contact);
        matches.push({
          contact,
          reason: "Similar name + company",
          confidence: 0.87,
          strong: false,
        });
      } else if (sameTitle) {
        matched.add(contact);
        matches.push({ contact, reason: "Similar name + title", confidence: 0.85, strong: false });
      }
    }
  }

  return matches.sort((a, b) => b.confidence - a.confidence);
}

/**
 * Match one probe against a small in-memory population, building a throwaway index.
 *
 * Convenience for callers that already hold a short candidate list (the extension's
 * pre-limited page resolve, a smoke test). Never call this in a loop over many probes —
 * that rebuilds the index every iteration and is slower than the O(N) scan it replaced.
 * Generic so a caller holding full `Contact` rows gets `contact: Contact` back.
 */
export function matchAgainst<T extends DuplicateSubject>(
  existing: T[],
  incoming: DuplicateProbe
): DuplicateMatch<T>[] {
  return findDuplicateCandidatesIndexed(
    buildDuplicateIndex(existing),
    incoming
  ) as DuplicateMatch<T>[];
}

export function daysAgo(date: Date | string | null | undefined) {
  if (!date) return Infinity;
  const d = typeof date === "string" ? new Date(date) : date;
  return Math.floor((Date.now() - d.getTime()) / (1000 * 60 * 60 * 24));
}
