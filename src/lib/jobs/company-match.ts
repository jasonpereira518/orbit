/**
 * Deciding whether a job posting and a contact work at the same employer.
 *
 * Pure — no `@/db` — so `scripts/smoke-job-company-match.ts` drives it directly.
 *
 * A new module rather than a reuse, and the reason is worth stating because reuse looks
 * obvious here and is wrong twice over:
 *
 *   - `normalizeCompanyKey` is a lowercase/punctuation normaliser, not a matcher. It maps
 *     "Capital One" → "capital one", "Capital One, N.A." → "capital one n a" and
 *     "capitalone" → "capitalone". None of those three collide, which is exactly the case
 *     this has to get right.
 *   - `companyFamilyKey` is built for seating a constellation, and its fallback is "first
 *     token of three or more characters". That makes "Apple Bank" match "Apple" — fine when
 *     the cost is two dots sitting near each other on a star map, not fine when the cost is
 *     telling somebody their contact works where a job just opened.
 *
 * `nameSimilarity` from `duplicates.ts` was also considered and rejected: it is tuned for
 * people, and a 0.85 threshold on company names makes "Stripe" ≈ "Strive". A key-set
 * intersection is auditable — you can look at a match and say which key fired. A similarity
 * score is not.
 */
import { canonicalCompanyClusterName } from "@/lib/company-family";
import { normalizeCompanyKey } from "@/lib/company-name";

/**
 * Below this, a key is too generic to match on anything but an exact `primary` comparison.
 * "hp", "ey", "x" and "ai" would otherwise collide with a large slice of any job feed.
 */
export const MIN_KEY_CHARS = 4;

export type CompanyKeySet = {
  /** The canonical form: known aliases resolved, punctuation flattened. */
  primary: string;
  /** Legal and geographic suffixes removed, when that differs from `primary`. */
  stripped: string | null;
  /** `primary` with spaces removed — the "capitalone" ↔ "capital one" bridge. */
  collapsed: string;
  /**
   * Every form this name may be compared on, `primary` included, each at least
   * `MIN_KEY_CHARS` long.
   *
   * A set rather than three named fields because the forms COMPOSE: "Capital One, N.A."
   * only reaches "capitalone" by stripping the suffix AND then collapsing the spaces, and a
   * pairwise comparison of named fields silently misses exactly that combination. It did,
   * until `scripts/smoke-job-company-match.ts` caught it.
   */
  variants: string[];
};

/**
 * Suffixes stripped to produce the `stripped` variant.
 *
 * The legal ones are listed here even though `stripTrailingInc` exists, and that is not an
 * oversight: `canonicalCompanyClusterName` only uses the stripped form to look up an ALIAS,
 * and when no alias matches it returns the original display name — so "Stripe, Inc." arrives
 * here as "stripe inc", suffix intact. Discovered by
 * `scripts/smoke-job-company-match.ts`, which is why that case is pinned there.
 *
 * Kept as a separate list rather than by widening `stripTrailingInc`, deliberately: that
 * function backs constellation clustering, and changing it would move people on somebody's
 * star map as a side effect of a job-matching change.
 */
const EXTRA_SUFFIXES = [
  "inc",
  "incorporated",
  "llc",
  "llp",
  "ltd",
  "limited",
  "corp",
  "corporation",
  "co",
  "company",
  "n a",
  "na",
  "plc",
  "gmbh",
  "sa",
  "ag",
  "nv",
  "bv",
  "ab",
  "oy",
  "pte ltd",
  "pte",
  "pty",
  "usa",
  "us",
  "group",
  "holdings",
  "holding",
  "technologies",
  "technology",
  "labs",
  "lab",
  "global",
  "international",
];

const SUFFIX_RE = new RegExp(`(?:\\s+(?:${EXTRA_SUFFIXES.join("|")}))+$`, "i");

function stripExtraSuffixes(key: string): string {
  let out = key;
  // Looped because real names stack them: "Acme Technologies Group Inc" → "acme".
  for (let i = 0; i < 4; i++) {
    const next = out.replace(SUFFIX_RE, "").trim();
    if (next === out) break;
    out = next;
  }
  return out;
}

export function jobCompanyKeys(raw: string | null | undefined): CompanyKeySet | null {
  const canonical = canonicalCompanyClusterName(raw);
  const primary = normalizeCompanyKey(canonical ?? raw ?? "");
  if (!primary) return null;
  const strippedRaw = stripExtraSuffixes(primary);
  const stripped = strippedRaw && strippedRaw !== primary ? strippedRaw : null;
  const collapse = (v: string) => v.replace(/\s+/g, "");

  const variants = [...new Set([primary, stripped, collapse(primary), stripped ? collapse(stripped) : null])]
    .filter((v): v is string => Boolean(v) && v!.length >= MIN_KEY_CHARS);

  return { primary, stripped, collapsed: collapse(primary), variants };
}

/**
 * Whether two key sets name the same employer.
 *
 * One rule keeps this from over-matching: no form shorter than `MIN_KEY_CHARS` ever enters
 * `variants`, so short, substring-prone names ("hp", "ey", "x") can only ever match by exact
 * canonical equality.
 */
export function companiesMatch(a: CompanyKeySet, b: CompanyKeySet): boolean {
  // An exact canonical match always counts, even for a name too short to have variants —
  // "HP" is a real employer, and it must match "HP" while never matching "HPE".
  if (a.primary === b.primary) return true;
  const other = new Set(b.variants);
  return a.variants.some((v) => other.has(v));
}

/**
 * The ONE key a company is filed under, so two spellings of the same employer land in the
 * same bucket and the matcher can look a company up instead of comparing it against every
 * watched company in turn.
 *
 * This is the most-reduced variant: suffixes stripped, then spaces collapsed. It is what
 * makes the lookup work in BOTH directions, which a set of lookup keys does not:
 *
 *   The posting side is a single indexed column (`job_postings.company_key`). Filing a
 *   posting under `primary` and probing it with the contact's variants finds "Capital One"
 *   from a contact at "Capital One, N.A." — but NOT the reverse, because no probe key can
 *   be longer than the stored one. A feed whose name carries the suffix and a contact whose
 *   name does not is an ordinary case, and it would silently never match.
 *
 *   Reducing both sides first removes the direction entirely: "Capital One", "Capital One,
 *   N.A." and "capitalone" all file under `capitalone`.
 *
 * Falls back to `primary` when the reduced form is too short to be safe — "HP" stays "hp"
 * and can then only match by exact equality, which is the one comparison `companiesMatch`
 * allows a name that short. Over-reduction is the failure mode this guards: "Apple Bank"
 * reduces to `applebank`, never to `apple`.
 *
 * The bucket is a cheap pre-filter, not the decision. `companiesMatch` still has the final
 * say on every candidate it returns, because that is the rule you can audit a match against.
 */
export function jobCompanyBucketKey(keys: CompanyKeySet): string {
  const reduced = (keys.stripped ?? keys.primary).replace(/\s+/g, "");
  return reduced.length >= MIN_KEY_CHARS ? reduced : keys.primary;
}
