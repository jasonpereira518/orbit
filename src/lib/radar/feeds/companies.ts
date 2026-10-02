/**
 * Which companies a headline might be about. Pure.
 *
 * Candidates, not verdicts. A headline names its subject with capitalized words, so every
 * run of one to three of them (after dropping words that start sentences and titles for
 * other reasons) is filed under its `jobCompanyBucketKey`. The nightly run only ever asks
 * for the keys of companies an account's own contacts work at, and `companiesMatch` has the
 * final say on each hit, so a junk candidate ("Acquires") costs a row and never a card. The
 * known weakness is a company named with an ordinary word at the start of a sentence-case
 * headline ("Linear algebra…"); the card shows the headline, and a dismissal teaches the
 * model to weigh news less for that account.
 */
import { jobCompanyBucketKey, jobCompanyKeys } from "@/lib/jobs/company-match";
import { NEWS_COMPANIES_PER_ITEM } from "@/lib/radar/feeds/sources";

/** Capitalized words that are not company names in a headline. */
const STOP = new Set(
  [
    "a", "an", "the", "and", "or", "but", "of", "in", "on", "at", "to", "for", "with", "from", "by", "as", "is", "are",
    "was", "were", "be", "it", "its", "this", "that", "these", "those", "how", "why", "what", "when", "where", "who",
    "which", "we", "you", "i", "my", "our", "your", "their", "his", "her", "here", "there", "new", "now", "after",
    "before", "about", "into", "over", "under", "up", "down", "out", "not", "no", "yes", "all", "more", "most", "just",
    "show", "ask", "tell", "hn", "launch", "launches", "ai", "us", "uk", "eu", "ceo", "cto", "cfo", "vc", "ipo",
    "report", "reports", "review", "exclusive", "breaking", "update", "live", "video", "podcast", "today", "week",
    "monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday", "january", "february", "march",
    "april", "may", "june", "july", "august", "september", "october", "november", "december",
  ]
);

const isCapitalized = (w: string) => /^[A-Z0-9][\w.&'’-]*$/.test(w) && /[A-Za-z]/.test(w);

/** Trim possessives and trailing punctuation: "Apple's" → "Apple", "Stripe," → "Stripe". */
function tidy(word: string): string {
  return word.replace(/[’']s$/i, "").replace(/[.,:;!?)"”]+$/, "").replace(/^[("“]+/, "");
}

export type CompanyCandidate = { name: string; key: string };

export function headlineCompanies(title: string): CompanyCandidate[] {
  const words = title.split(/\s+/).map(tidy).filter(Boolean);
  const runs: string[][] = [];
  let run: string[] = [];
  for (const w of words) {
    if (isCapitalized(w) && !STOP.has(w.toLowerCase())) run.push(w);
    else {
      if (run.length) runs.push(run);
      run = [];
    }
  }
  if (run.length) runs.push(run);

  const out: CompanyCandidate[] = [];
  const seen = new Set<string>();
  for (const r of runs) {
    // Every contiguous 1–3 word window, longest first: "Capital One" before "Capital".
    for (let size = Math.min(3, r.length); size >= 1; size--) {
      for (let i = 0; i + size <= r.length; i++) {
        const name = r.slice(i, i + size).join(" ");
        if (name.length < 2) continue;
        const keys = jobCompanyKeys(name);
        if (!keys) continue;
        const key = jobCompanyBucketKey(keys);
        if (!key || seen.has(key)) continue;
        seen.add(key);
        out.push({ name: name.slice(0, 120), key });
        if (out.length >= NEWS_COMPANIES_PER_ITEM) return out;
      }
    }
  }
  return out;
}
