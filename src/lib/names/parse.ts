/**
 * A person's name as sources hand it over, made fit to store: "DOE, JANE (Acme)" → Jane Doe.
 * Only reshapes; whether it is a person at all is `classifyName`'s question.
 */

export type PersonName = { fullName: string; firstName: string | null; lastName: string | null };

const HONORIFICS = new Set(["mr", "mrs", "ms", "miss", "mx", "dr", "prof", "sir", "dame"]);
/** Kept: they are part of what the person is called. */
const GENERATIONAL = new Set(["jr", "sr", "ii", "iii", "iv"]);
/** Dropped: letters after a name, not the name. */
const CREDENTIALS = new Set(["phd", "md", "mba", "cpa", "esq", "jd", "pe", "rn", "dds", "cfa", "pmp"]);
/** Lower-case inside a name when recasing ("Ludwig van Beethoven"), never as the first word. */
const PARTICLES = new Set(["van", "von", "de", "der", "den", "da", "das", "do", "dos", "del", "della", "di", "du", "la", "le", "bin", "binti", "al"]);

const bare = (w: string) => w.toLowerCase().replace(/\./g, "");

/** "o'brien" → "O'Brien", "anne-marie" → "Anne-Marie". */
function capWord(w: string): string {
  return w.toLowerCase().replace(/(^|['’-])(\p{L})/gu, (_, sep: string, c: string) => sep + c.toUpperCase());
}

/** First word, then the rest: what five of the old six splitters did. */
export function splitName(fullName: string | null | undefined): { firstName: string | null; lastName: string | null } {
  const parts = (fullName ?? "").trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return { firstName: null, lastName: null };
  return { firstName: parts[0], lastName: parts.length > 1 ? parts.slice(1).join(" ") : null };
}

export function formatPersonName(raw: string | null | undefined): PersonName | null {
  let n = (raw ?? "")
    .replace(/[\u0000-\u001f]/g, " ")
    .replace(/^["'“”‘’\s]+|["'“”‘’\s]+$/g, "")
    // "Jane Doe (Acme)", "Jane Doe [External]", "Jane Doe via Google Docs", "Jane Doe | Acme"
    .replace(/\s*[([{][^)\]}]*[)\]}]\s*$/g, "")
    .replace(/\s+(?:via|from|@)\s+.+$/i, "")
    .replace(/\s+[|•·]\s+.+$/, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!n) return null;

  // "Doe, Jane" → "Jane Doe"; "Jane Doe, PhD" / "Jane Doe, Jr." keep their order.
  const commas = n.split(",").map((s) => s.trim()).filter(Boolean);
  if (commas.length >= 2) {
    const tail = commas.slice(1).map(bare);
    const trailing = tail.every((t) => t.split(/\s+/).every((w) => GENERATIONAL.has(w) || CREDENTIALS.has(w)));
    if (trailing) n = [commas[0], ...commas.slice(1).filter((t) => GENERATIONAL.has(bare(t)))].join(" ");
    else if (commas.length === 2 && commas[0].split(" ").length <= 2 && commas[1].split(" ").length <= 2) {
      n = `${commas[1]} ${commas[0]}`;
    }
  }

  let words = n.split(" ");
  while (words.length > 1 && HONORIFICS.has(bare(words[0]))) words.shift();
  while (words.length > 1 && CREDENTIALS.has(bare(words[words.length - 1]))) words.pop();

  // Recase only a name typed all one case; "McKinsey" and "DeShawn" are kept as written.
  const letters = words.join("").replace(/[^\p{L}]/gu, "");
  const oneCase = letters.length > 1 && (letters === letters.toUpperCase() || letters === letters.toLowerCase());
  if (oneCase && /\p{Lu}|\p{Ll}/u.test(letters)) {
    words = words.map((w, i) => {
      const b = bare(w);
      if (i > 0 && PARTICLES.has(b)) return b;
      if (GENERATIONAL.has(b)) return b === "jr" || b === "sr" ? `${b[0].toUpperCase()}${b[1]}.` : b.toUpperCase();
      return capWord(w);
    });
  }

  const fullName = words.join(" ");
  return { fullName, ...splitName(fullName) };
}
