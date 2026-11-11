/**
 * The one way to compare two names in memory: "José O'Neil" and "jose o neil" are the same key.
 *
 * Unicode-aware, so a name in any script keeps its letters (the old `[^a-z0-9]` keys turned
 * "李伟" into "" and it could never match anything). For Latin names the key is exactly what
 * the old normalisers produced, so swapping one in changes no Latin comparison.
 *
 * NOT for stored or indexed keys: `ignored_people.name_key`, `recruiters.name_normalized`, the
 * `nm:` roster keys and `lower(trim(full_name))` keep their own spellings (see `smoke-names`).
 */
export function nameKey(s: string | null | undefined): string {
  return (s ?? "")
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

export function nameTokens(s: string | null | undefined): string[] {
  const key = nameKey(s);
  return key ? key.split(" ") : [];
}

/** Edit distance where swapping two adjacent letters ("Smtih") counts as one edit, not two. */
export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let before: number[] = [];
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const curr = [i];
    for (let j = 1; j <= b.length; j++) {
      curr[j] = Math.min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) curr[j] = Math.min(curr[j], before[j - 2] + 1);
    }
    before = prev;
    prev = curr;
  }
  return prev[b.length];
}

/** 0–1 similarity from edit distance over the keys; names under 4 letters must match exactly. */
export function nameSimilarity(a: string | null | undefined, b: string | null | undefined): number {
  const left = nameKey(a);
  const right = nameKey(b);
  if (!left || !right) return 0;
  if (left === right) return 1;
  const maxLen = Math.max(left.length, right.length);
  if (maxLen < 4) return 0;
  return Math.max(0, 1 - levenshtein(left, right) / maxLen);
}
