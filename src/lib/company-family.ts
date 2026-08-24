import {
  displayCompanyName,
  normalizeCompanyName,
} from "@/lib/company-name";

/**
 * Exact aliases → one constellation cluster / canonical display name.
 * AWS and "Amazon Web Services" collapse together; Amazon retail stays separate.
 */
const EXACT_ALIAS_TO_CANONICAL: Record<string, string> = {
  aws: "Amazon Web Services",
  "amazon web services": "Amazon Web Services",
  "amazon web services (aws)": "Amazon Web Services",
  "amazon web services aws": "Amazon Web Services",
  amzn: "Amazon",

  meta: "Meta",
  "meta platforms": "Meta",
  "meta platforms inc": "Meta",
  "meta platforms, inc": "Meta",
  "meta platforms, inc.": "Meta",
  facebook: "Meta",
  "facebook inc": "Meta",

  google: "Google",
  alphabet: "Google",
  "alphabet inc": "Google",
  "google llc": "Google",
  "google inc": "Google",
  deepmind: "Google DeepMind",
  "google deepmind": "Google DeepMind",
  "google deep mind": "Google DeepMind",

  microsoft: "Microsoft",
  msft: "Microsoft",
  "microsoft corporation": "Microsoft",

  ibm: "IBM",
  "international business machines": "IBM",
  "international business machines corporation": "IBM",

  "jp morgan": "JPMorgan Chase",
  "j.p. morgan": "JPMorgan Chase",
  jpmorgan: "JPMorgan Chase",
  "jpmorgan chase": "JPMorgan Chase",
  "jp morgan chase": "JPMorgan Chase",

  bcg: "Boston Consulting Group",
  "boston consulting group": "Boston Consulting Group",

  bain: "Bain & Company",
  "bain & company": "Bain & Company",
  "bain and company": "Bain & Company",

  yc: "Y Combinator",
  "y combinator": "Y Combinator",

  a16z: "Andreessen Horowitz",
  "andreessen horowitz": "Andreessen Horowitz",

  sequoia: "Sequoia Capital",
  "sequoia capital": "Sequoia Capital",

  openai: "OpenAI",
  "open ai": "OpenAI",
};

function stripTrailingInc(normalized: string) {
  return normalized
    .replace(/[.,']/g, "")
    .replace(/\s*\(.*\)\s*$/g, "")
    .replace(
      /\s+(inc|incorporated|llc|ltd|limited|corp|corporation|co|company)\.?$/i,
      ""
    )
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Canonical display name for constellation clustering.
 * Exact aliases (AWS ↔ Amazon Web Services) become one cluster.
 */
export function canonicalCompanyClusterName(
  raw: string | null | undefined
): string | null {
  const display = raw ? displayCompanyName(raw) : "";
  if (!display) return null;

  const normalized = stripTrailingInc(normalizeCompanyName(display));
  const aliased = EXACT_ALIAS_TO_CANONICAL[normalized];
  if (aliased) return aliased;

  // "Amazon Web Services (AWS)" style already stripped → check again
  const withoutAwsParen = stripTrailingInc(
    normalizeCompanyName(display.replace(/\(\s*aws\s*\)/gi, "").trim())
  );
  if (EXACT_ALIAS_TO_CANONICAL[withoutAwsParen]) {
    return EXACT_ALIAS_TO_CANONICAL[withoutAwsParen];
  }

  return displayCompanyName(display);
}
