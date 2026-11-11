import { classifyName } from "./classify";
import { nameSimilarity, nameTokens } from "./key";
import { sameGivenName } from "./nicknames";

/**
 * How two written names relate:
 *  - same: identical apart from case and spacing.
 *  - variant: one person written two ways — accents, punctuation, word order, a nickname or an
 *    initial for the first name, a middle name on one side ("Mike Torres", "Michael J. Torres").
 *  - first_only: one side is a first name the other's first name can be ("Mike" ~ "Michael Torres").
 *  - typo: close enough to be a misspelling or a transcription slip ("Jon Smtih").
 *  - different.
 */
export type NameRelation = "same" | "variant" | "first_only" | "typo" | "different";

const firstCompatible = (a: string, b: string) =>
  sameGivenName(a, b) || (a.length === 1 && b.startsWith(a)) || (b.length === 1 && a.startsWith(b));

export function compareNames(a: string | null | undefined, b: string | null | undefined): NameRelation {
  const ta = nameTokens(a);
  const tb = nameTokens(b);
  if (!ta.length || !tb.length) return "different";
  if ((a ?? "").replace(/\s+/g, " ").trim().toLowerCase() === (b ?? "").replace(/\s+/g, " ").trim().toLowerCase()) return "same";
  if (ta.join(" ") === tb.join(" ")) return "variant";
  if ([...ta].sort().join(" ") === [...tb].sort().join(" ")) return "variant";
  if (ta.length === 1 || tb.length === 1) {
    if (ta.length === 1 && tb.length === 1) return sameGivenName(ta[0]!, tb[0]!) ? "variant" : nameSimilarity(a, b) >= 0.88 ? "typo" : "different";
    const [single, multi] = ta.length === 1 ? [ta, tb] : [tb, ta];
    return sameGivenName(single[0]!, multi[0]!) ? "first_only" : "different";
  }
  if (ta[ta.length - 1] === tb[tb.length - 1] && firstCompatible(ta[0]!, tb[0]!)) return "variant";
  return nameSimilarity(a, b) >= 0.88 ? "typo" : "different";
}

/** All-lower or all-upper: a name nobody cased, which a cased spelling of it may replace. */
const uncased = (s: string) => {
  const letters = s.replace(/[^\p{L}]/gu, "");
  return /\p{Lu}|\p{Ll}/u.test(letters) && (letters === letters.toLowerCase() || letters === letters.toUpperCase());
};

const REPLACEABLE = new Set(["handle", "email", "phone", "placeholder"]);

/**
 * THE rule for whether an incoming name may replace the one on file, for every automated
 * writer. Replaces an empty name, a handle, an address or a placeholder with a person's name;
 * a partial name with a fuller spelling of the same person ("Sarah" → "Sarah Chen"); an
 * uncased name with the cased one. Never shrinks a name, never swaps one person's name for
 * another's ("Michael Torres" stays, whatever a note calls him), never touches a name the
 * user typed or confirmed.
 */
export function shouldReplaceName(
  current: string | null | undefined,
  incoming: string | null | undefined,
  opts: { confirmed?: boolean; email?: string | null } = {}
): boolean {
  const next = incoming?.replace(/\s+/g, " ").trim();
  if (!next || opts.confirmed) return false;
  const now = current?.replace(/\s+/g, " ").trim();
  if (!now) return true;
  if (now === next) return false;
  const inc = classifyName(next, { email: opts.email }).verdict;
  if (inc !== "person_full" && inc !== "person_partial") return false;
  if (REPLACEABLE.has(classifyName(now, { email: opts.email }).verdict)) return true;
  const relation = compareNames(now, next);
  if (relation === "same" || relation === "variant") return uncased(now) && !uncased(next) && nameTokens(now).join(" ") === nameTokens(next).join(" ");
  return relation === "first_only" && nameTokens(next).length > nameTokens(now).length;
}
