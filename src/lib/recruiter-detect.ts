/**
 * Provider-agnostic recruiter detection.
 *
 * Extracted out of `gmail.ts` (which re-exports these for backward compatibility) so
 * `outlook-scan-processor.ts` can classify Microsoft Graph messages with the exact same
 * heuristics as Gmail, rather than a parallel copy that quietly drifts. Nothing here
 * knows about Gmail's or Graph's wire shapes — it only reads generic from/subject/snippet
 * strings, which both providers' scan processors normalize their headers into first.
 */
import { nameFromEmail } from "@/lib/names/from-identifier";
import { formatPersonName } from "@/lib/names/parse";

const RECRUITER_TITLE_RE =
  /\b(recruiter|talent\s*acquisition|sourcer|staffing|headhunter|talent\s*partner|technical\s*recruiter)\b/i;

export const AGENCY_DOMAIN_HINTS = [
  "robertwalters",
  "michaelpage",
  "hays",
  "roberthalf",
  "kforce",
  "aerotek",
  "randstad",
  "adecco",
  "manpower",
  "teksystems",
  "insightglobal",
  "cybercoders",
  "jeffersonfrank",
  "harveynash",
];

export function parseFromHeader(from: string): { name: string; email: string } | null {
  // A display name only ever precedes `<…>`. The old single pattern let it swallow the start
  // of a BARE address — `no-reply@ashbyhq.com` parsed as "no-repl" at `y@ashbyhq.com` — and
  // Graph hands out bare addresses whenever a sender has no name.
  const trimmed = from.trim();
  const angled = trimmed.match(/^(?:"?([^"<]*?)"?\s*)?<([^\s<>]+@[^\s<>]+)>$/);
  const bare = angled ? null : trimmed.match(/^([^\s<>"]+@[^\s<>"]+)$/);
  const address = angled?.[2] ?? bare?.[1];
  if (!address) return null;
  const email = address.trim().toLowerCase();
  const shown = (angled?.[1] || "").trim().replace(/^"|"$/g, "");
  // A display name is formatted ("DOE, JANE" → Jane Doe); none, the address is read.
  const name = formatPersonName(shown)?.fullName || nameFromEmail(email)?.full || email.split("@")[0].replace(/[._]/g, " ");
  return { name, email };
}

const FREE_MAIL_LABELS = new Set([
  "gmail", "googlemail", "yahoo", "ymail", "outlook", "hotmail", "live", "msn", "icloud", "me", "mac", "aol", "proton", "protonmail",
]);

/** The middle of a two-part public suffix: `bbc.co.uk` is the BBC, not "Co". */
const SECOND_LEVEL_LABELS = new Set(["co", "com", "ac", "org", "net", "gov", "edu", "ne", "or"]);

/**
 * The company a domain belongs to — the label before the public suffix, never the first one.
 * Companies put real recruiters on subdomains: `talent.capitalone.com` is Capital One's, and
 * reading the first label turned it into a firm called "Talent".
 */
export function firmFromEmail(email: string): string | null {
  const labels = (email.split("@")[1] ?? "").toLowerCase().split(".").filter(Boolean);
  if (labels.length < 2) return null;
  let i = labels.length - 2;
  if (i > 0 && labels[labels.length - 1].length === 2 && SECOND_LEVEL_LABELS.has(labels[i])) i -= 1;
  const base = labels[i];
  if (!base || FREE_MAIL_LABELS.has(base)) return null;
  return base.charAt(0).toUpperCase() + base.slice(1);
}

/** Words that indicate a sender is a department, automated bot, or company, NOT a real human. */
const NON_HUMAN_NAME_PATTERNS = [
  /\b(recruiting|recruitment|talent|acquisition|careers|jobs|job|hiring|sourcer|staffing)\b/i,
  /\b(hr|human\s*resources|people\s*team|people\s*ops|operations|coordination)\b/i,
  /\b(no-reply|noreply|donotreply|do-not-reply|notifications?|alerts?|updates?|bot|automated)\b/i,
  /\b(support|admin|info|hello|contact|inquiries|team|office|services|solutions|group)\b/i,
  /\b(university\s*relations|campus\s*recruiting|early\s*talent|college\s*relations)\b/i,
  /\b(greenhouse|lever|workday|ashby|smartrecruiters|jobvite|indeed|linkedin|handshake|ripplematch|untapped|y\s*combinator)\b/i,
  /\b(inc|llc|corp|corporation|ltd|technologies|systems|labs|ventures|partners|holdings)\b/i,
];

/**
 * Validates whether a candidate recruiter name is a genuine human being's name.
 * Rejects organizations, ATS platforms, generic bot accounts, email handles, and single words.
 */
export function isRealHumanName(name: string | null | undefined): { valid: boolean; reason?: string } {
  if (!name) return { valid: false, reason: "Name is empty" };
  const trimmed = name.trim().replace(/\s+/g, " ");

  if (trimmed.length < 3) return { valid: false, reason: "Name is too short" };
  if (trimmed.length > 70) return { valid: false, reason: "Name is too long" };

  // Cannot contain email indicators or URLs
  if (/@|\.com\b|\.io\b|\.org\b|\.net\b|https?:|\/|\\/i.test(trimmed)) {
    return { valid: false, reason: "Name contains email or URL formatting" };
  }

  // Cannot contain digits or prohibited symbols
  if (/\d|[#$<>{}[\]~_=+*^]/.test(trimmed)) {
    return { valid: false, reason: "Name contains digits or invalid characters" };
  }

  // Check against non-human patterns
  for (const pattern of NON_HUMAN_NAME_PATTERNS) {
    if (pattern.test(trimmed)) {
      return { valid: false, reason: `Matches non-human pattern: ${pattern.source}` };
    }
  }

  // Must consist of at least two words (First and Last name)
  const tokens = trimmed.split(/\s+/).filter(Boolean);
  if (tokens.length < 2) {
    return { valid: false, reason: "Requires at least a first and last name" };
  }

  // Each token must have at least one valid letter character
  if (!tokens.every((t) => /^[\p{L}'-]+$/u.test(t) && t.length >= 2)) {
    return { valid: false, reason: "Tokens must be valid alphabetic name parts of at least 2 characters" };
  }

  return { valid: true };
}

/**
 * Extracts a recruiter's personal LinkedIn profile URL from email text, signature, or links.
 */
export function extractLinkedinFromContent(text: string | null | undefined): string | null {
  if (!text) return null;
  const match = text.match(/https?:\/\/(?:[a-zA-Z0-9-]+\.)?linkedin\.com\/in\/([a-zA-Z0-9_-]+)/i);
  if (!match) return null;
  const slug = match[1]?.trim().toLowerCase();
  if (!slug || ["jobs", "company", "school", "feed", "help"].includes(slug)) return null;
  return `https://www.linkedin.com/in/${slug}`;
}

export function looksLikeRecruiter(opts: {
  from: string;
  subject: string;
  snippet: string;
}): boolean {
  const blob = `${opts.from} ${opts.subject} ${opts.snippet}`;
  if (RECRUITER_TITLE_RE.test(blob)) return true;
  const emailMatch = opts.from.match(/@([^\s>]+)/);
  const domain = emailMatch?.[1]?.toLowerCase() || "";
  if (AGENCY_DOMAIN_HINTS.some((h) => domain.includes(h))) return true;
  if (
    /\b(open\s+role|hiring|job\s+opportunity|opportunity\s+with|are\s+you\s+open)\b/i.test(
      blob
    ) &&
    /\b(recruit|talent|staffing|hiring\s+for)\b/i.test(blob)
  ) {
    return true;
  }
  return false;
}
