import {
  AGENCY_DOMAIN_HINTS,
  ATS_SENDER_DOMAINS,
  EXCLUDED_JOB_BOARD_DOMAINS,
  type GmailHeaderSummary,
} from "@/lib/gmail";
import { firmFromEmail, parseFromHeader } from "@/lib/recruiter-detect";
import type { RecruiterStage } from "@/lib/recruiter-stages";

/**
 * The cheap filter that stands between a mailbox and the classifier.
 *
 * Everything here is deterministic string work on headers already in hand. Its only job is to
 * make the expensive step small: a thread that reaches the LLM costs tokens on the user's own
 * key, so the bar for getting there is deliberately high, and what gets dropped is counted
 * rather than silently discarded.
 *
 * Pure and I/O-free so it can be tested against fixtures without Gmail or a database.
 */

/**
 * What kind of correspondent sent a thread. The distinction is load-bearing: it decides not
 * just *whether* to spend a classification but *what the result may write*.
 *
 * - `bulk`   — newsletters, digests, job boards. Dropped outright.
 * - `ats`    — applicant-tracking robots and career-site autoresponders. No human to save, so
 *              these feed opportunity stages only, never recruiter contacts. Their templates
 *              are rigid enough to read by rule, which is why they are cheap to keep.
 * - `human`  — a person. The only kind that can become a recruiter contact, and the only kind
 *              worth an LLM call.
 */
export type SenderKind = "bulk" | "ats" | "human";

function domainOf(from: string): string {
  const match = from.match(/@([^\s>]+)/);
  return match?.[1]?.toLowerCase() ?? "";
}

function localPartOf(from: string): string {
  const match = from.match(/([^\s<]+)@/);
  return match?.[1]?.toLowerCase() ?? "";
}

/**
 * Bulk detection by header rather than by denylist.
 *
 * A domain list only ever knows the newsletters someone already complained about. Every piece
 * of legitimate bulk mail sets `List-Unsubscribe` — that is what the header is for — so this
 * catches the next one too.
 */
export function isBulkMail(
  header: Pick<GmailHeaderSummary, "listUnsubscribe" | "listId" | "precedence">
): boolean {
  if (header.listUnsubscribe.trim()) return true;
  if (header.listId.trim()) return true;
  return /\b(bulk|list|auto_reply|junk)\b/i.test(header.precedence);
}

/** Robot mailboxes: nothing behind them replies. */
const AUTOMATED_LOCAL_PARTS =
  /^(no-?reply|do-?not-?reply|donotreply|auto-?reply|notifications?|mailer|bounce|postmaster)/i;

/**
 * Role addresses rather than people — a department, not a correspondent.
 *
 * Matched on the local part alone, never on the domain. Companies routinely put real
 * recruiters on `talent.` and `careers.` subdomains (`abigail.darko@talent.example.com` is a
 * person), so a domain rule here would quietly demote exactly the humans this feature exists
 * to capture, while `careers@example.com` is caught by the local part either way.
 */
const ROLE_LOCAL_PARTS =
  /^(careers?|recruit(ing|ment|er)?|talent[a-z]*|jobs?|campus|university|hiring|hr|inbox|info|hello|events?|team|support|admin|contact|apply|applications?)([._+-]|$)/i;

export function classifySenderKind(
  header: Pick<GmailHeaderSummary, "from" | "listUnsubscribe" | "listId" | "precedence">
): SenderKind {
  const domain = domainOf(header.from);
  if (!domain) return "bulk";

  if (EXCLUDED_JOB_BOARD_DOMAINS.some((d) => domain === d || domain.endsWith(`.${d}`))) {
    return "bulk";
  }
  if (isBulkMail(header)) return "bulk";

  if (isAtsVendorDomain(domain)) return "ats";

  const local = localPartOf(header.from);
  if (AUTOMATED_LOCAL_PARTS.test(local)) return "ats";
  if (ROLE_LOCAL_PARTS.test(local)) return "ats";

  return "human";
}

/**
 * Stage rules for automated hiring mail.
 *
 * ATS templates are rigid — that rigidity is the whole reason this mail can be kept without
 * paying for it. Order matters: an outcome ("we will not be moving forward") must be tested
 * before an invitation, because rejection notices routinely quote the step the candidate was
 * being considered for.
 *
 * Returns null when nothing matches, which sends the thread to the classifier rather than
 * inventing a stage. A wrong stage is worse than an absent one.
 */
const ATS_STAGE_RULES: Array<{ stage: RecruiterStage; pattern: RegExp }> = [
  {
    stage: "rejected",
    pattern:
      /\b(not (be )?(moving|proceeding|move) forward|will not be moving|decided not to (proceed|move)|no longer under consideration|other candidates|unable to offer|unfortunately|not to proceed with your (candidacy|application)|position has been filled)\b/i,
  },
  {
    stage: "offer",
    pattern: /\b(offer letter|we(&#39;re| are)? (excited|pleased) to offer|your offer|offer of employment)\b/i,
  },
  {
    stage: "interviewing",
    pattern:
      /\b(on-?site|final round|team interview|panel interview|interview (invitation|request|scheduled)|video interview|pre-?recorded video)\b/i,
  },
  {
    stage: "screening",
    pattern:
      /\b(assessment|hackerrank|codesignal|coding challenge|online test|phone screen|recruiter screen|screening call|next step|move(d)? (your application )?forward|digital interview)\b/i,
  },
  {
    stage: "applied",
    // The acknowledgement wording varies more than any other ATS template — "thank you for
    // taking the time to apply", "thanks for your interest in applying" — so this matches a
    // gratitude opener within a short distance of an apply/application word rather than
    // trying to enumerate the phrasings.
    pattern:
      /\b(thank(s| you)[^.!?]{0,60}\bapp(ly|lying|lication)\b|we(&#39;ve| have)? received your application|application (received|submitted)|your submission)\b/i,
  },
];

export function deriveAtsStage(text: string): RecruiterStage | null {
  for (const rule of ATS_STAGE_RULES) {
    if (rule.pattern.test(text)) return rule.stage;
  }
  return null;
}

// --- Scored prefilter for human senders -------------------------------------------------

const RECRUITER_TITLE_RE =
  /\b(recruiter|talent\s*acquisition|sourcer|staffing|headhunter|talent\s*partner|technical\s*recruiter|recruiting\s*(coordinator|manager)|campus\s*recruiter)\b/i;

const SCHEDULING_RE =
  /\b(availability|calendly|schedule\s+a\s+(time|call|chat)|book\s+a\s+time|are\s+you\s+free|time\s+slots?)\b/i;

const OUTCOME_RE =
  /\b(offer|compensation|salary|moving forward|next steps?|not moving forward|other candidates|final round)\b/i;

const OPPORTUNITY_RE =
  /\b(open\s+role|opening|job\s+opportunity|opportunity\s+(with|at)|are\s+you\s+open|position\s+at|hiring\s+for|new\s+grad|internship)\b/i;

/**
 * Precision-biased by request: a thread must clear `TRIAGE_ACCEPT` to be worth a token. The
 * band beneath it is dropped too, but counted — see `TriageOutcome.deferred`. That counter is
 * the only honest way to tell an aggressive threshold from a quiet mailbox.
 */
export const TRIAGE_ACCEPT = 3;
export const TRIAGE_REJECT = 1;

export type ThreadSignals = {
  /** Every message in the thread, oldest first. */
  headers: GmailHeaderSummary[];
  /** The connected mailbox's own address — the only way to tell the two sides apart. */
  userEmail: string;
  /** Verdict remembered from an earlier scan, if this sender has been judged before. */
  cachedVerdict?: "recruiter" | "not_recruiter" | null;
};

export type TriageOutcome = {
  kind: SenderKind;
  score: number;
  decision: "classify" | "ats_rule" | "deferred" | "rejected";
  /** Why, in a few words — surfaced in the review queue and useful when retuning. */
  reasons: string[];
};

export function triageThread(signals: ThreadSignals): TriageOutcome {
  const { headers, userEmail, cachedVerdict } = signals;
  const reasons: string[] = [];

  if (headers.length === 0) {
    return { kind: "bulk", score: 0, decision: "rejected", reasons: ["no headers"] };
  }

  const mine = userEmail.trim().toLowerCase();
  const isFromUser = (h: GmailHeaderSummary) =>
    Boolean(mine) && h.from.toLowerCase().includes(mine);

  // The correspondent is whoever wrote the first message that was not the user. A thread the
  // user started and nobody answered has no inbound message at all — that is cold outreach,
  // and the recipient is the correspondent instead.
  const inbound = headers.filter((h) => !isFromUser(h));
  const userReplied = headers.some(isFromUser);
  // For a cold thread nobody answered, the correspondent is the recipient rather than the
  // sender — reading `from` there would classify the user's own domain.
  const correspondent: GmailHeaderSummary =
    inbound[0] ?? { ...headers[0], from: headers[0].to };
  const kind = classifySenderKind(correspondent);

  if (kind === "bulk") {
    return { kind, score: 0, decision: "rejected", reasons: ["bulk mail"] };
  }

  if (cachedVerdict === "not_recruiter") {
    return { kind, score: 0, decision: "rejected", reasons: ["cached: not a recruiter"] };
  }

  if (kind === "ats") {
    return { kind, score: 0, decision: "ats_rule", reasons: ["automated hiring mail"] };
  }

  if (cachedVerdict === "recruiter") {
    return { kind, score: 99, decision: "classify", reasons: ["cached: known recruiter"] };
  }

  const blob = headers
    .map((h) => `${h.from} ${h.subject} ${h.snippet}`)
    .join(" ");
  const domain = domainOf(correspondent.from);

  let score = 0;
  if (RECRUITER_TITLE_RE.test(blob)) {
    score += 3;
    reasons.push("recruiter title");
  }
  if (AGENCY_DOMAIN_HINTS.some((h) => domain.includes(h))) {
    score += 3;
    reasons.push("agency domain");
  }
  if (OPPORTUNITY_RE.test(blob)) {
    score += 1;
    reasons.push("opportunity language");
  }
  if (SCHEDULING_RE.test(blob)) {
    score += 2;
    reasons.push("scheduling language");
  }
  if (OUTCOME_RE.test(blob)) {
    score += 2;
    reasons.push("outcome language");
  }
  if (userReplied && inbound.length > 0) {
    // Enough on its own. By this point the correspondent is a person (bulk and ATS are
    // already gone) and the thread matched the recruiter query, so a two-way exchange is both
    // the highest-value case and a rare one — the precision bias is meant to suppress
    // borderline broadcasts, not conversations the user actually took part in. A cold email
    // nobody answered is not an exchange: every sent-arm hit would otherwise reach the model.
    score += TRIAGE_ACCEPT;
    reasons.push("you replied");
  }

  const decision =
    score >= TRIAGE_ACCEPT
      ? "classify"
      : score >= TRIAGE_REJECT
        ? "deferred"
        : "rejected";

  return { kind, score, decision, reasons };
}

// --- Companies from automated mail ----------------------------------------------------------

export function isAtsVendorDomain(domain: string): boolean {
  return ATS_SENDER_DOMAINS.some((d) => domain === d || domain.endsWith(`.${d}`));
}

/**
 * An application that is not for a job. The gate on reading a stage by rule from a sender
 * that is not an ATS vendor: "Your application has been received" from a bank's no-reply is a
 * credit card, from a landlord an apartment, from a university a place.
 *
 * A deny-list rather than a list of job words: "Thank you for applying to Stripe" from
 * `no-reply@stripe.com` carries no job word at all, and a wrong card costs the user one click
 * ("Not a job") where a dropped real stage is invisible. Callers pass the From line too.
 */
const NON_JOB_APPLICATION_RE =
  /\b(credit\s*card|debit\s*card|\bcard\b|loan|mortgage|apartment|lease|rental|insurance|membership|passport|admissions?|financ(e|ing))\b/i;

export function isNonJobApplication(text: string): boolean {
  return NON_JOB_APPLICATION_RE.test(text);
}

/** What a display name wraps around the company: "Stripe Recruiting", "AMD Careers". */
const GENERIC_NAME_WORDS_RE =
  /\b(recruiting|recruitment|recruiters?|careers?|talent(\s+acquisition)?|hiring(\s+team)?|jobs?|team|no-?reply|notifications?|campus|university|early\s+careers?|people|hr|candidates?|applications?)\b/gi;

const VENDOR_NAMES_RE =
  /^(greenhouse|lever|workday|myworkday|icims|ashby|ashbyhq|jobvite|smartrecruiters|workable|bamboohr|taleo|oracle|pymetrics|hackerrank|hirevue|codesignal)$/i;

/** Words that end a company name in running text — a job title or filler follows it. */
const STOP_WORDS_RE =
  /^(engineer(ing)?|intern(ship)?s?|developer|analyst|manager|associate|scientist|designer|software|product|data|summer|fall|spring|winter|position|role|program|graduate|grad|co-?op|full|part|your|the|this|our|we|you|thank|thanks|hi|dear|update|congratulations|application|next|steps?|team|and|for|is|has)$/i;

/** Workday, iCIMS and Taleo put the tenant in the local part: `mastercard@myworkday.com`. */
const TENANT_LOCAL_PART_DOMAINS = ["myworkday.com", "icims.com", "taleo.net"];

/** A capitalized run of up to five words — the shape of a company name in a sentence. */
const NAME = String.raw`([A-Z0-9][\w&'’.-]*(?:\s+[A-Z0-9][\w&'’.-]*){0,4})`;

/**
 * No "Company - …" pattern on purpose: ATS subjects routinely open with the CANDIDATE's name
 * ("Jason - Update from Abridge"), and that rule filed a company called Jason.
 */
const PHRASE_PATTERNS = [
  new RegExp(String.raw`(?:[Aa]pplying|[Aa]pplied|[Aa]pplication|[Cc]andidacy|[Ii]nterest)\s+(?:to|with|at)\s+(?:the\s+)?${NAME}`),
  new RegExp(String.raw`\b(?:position|role|internship|opportunity|job|team)\s+at\s+${NAME}`),
  new RegExp(String.raw`\b(?:[Uu]pdate|[Mm]essage|[Nn]ote|[Nn]ews|[Ff]eedback)\s+from\s+${NAME}`),
  new RegExp(String.raw`\b[Yy]our\s+${NAME}\s+application\b`),
  new RegExp(String.raw`${NAME}\s+has\s+invited\s+you`),
];
/** A subject that ends "… at Plaid" names the company; mid-sentence "at" in a body does not. */
const SUBJECT_PATTERNS = [...PHRASE_PATTERNS, new RegExp(String.raw`\bat\s+${NAME}\s*[!.]?\s*$`)];
const BODY_PATTERNS = PHRASE_PATTERNS;

/** Short names read as acronyms: "amd" is AMD, "mastercard" is Mastercard. */
function fromToken(token: string): string {
  return token.length <= 4 ? token.toUpperCase() : token.charAt(0).toUpperCase() + token.slice(1);
}

/** Cuts a capture at the first word that cannot be part of a company name. */
function cleanCapture(raw: string): string | null {
  const words: string[] = [];
  for (const word of raw.trim().split(/\s+/)) {
    const bare = word.replace(/[!.,;:'’]+$/, "");
    if (!bare || STOP_WORDS_RE.test(bare)) break;
    words.push(bare);
    // "…application to Ramp. Unfortunately" — punctuation ends the name with the sentence.
    if (bare !== word) break;
  }
  const name = words.join(" ").trim();
  if (!name || name.length > 60 || VENDOR_NAMES_RE.test(name)) return null;
  return name;
}

function firstMatch(text: string, patterns: RegExp[]): string | null {
  for (const pattern of patterns) {
    const m = text.match(pattern);
    const name = m?.[1] ? cleanCapture(m[1]) : null;
    if (name) return name;
  }
  return null;
}

/**
 * "Stripe Recruiting" → Stripe, "Plaid via Lever" → Plaid. Trusted only when it carried a
 * generic word or is a single token: "Jane Smith" sending through Greenhouse is a person,
 * and a person is not a company.
 */
function companyFromDisplayName(from: string): string | null {
  const display = from.match(/^\s*"?([^"<]+?)"?\s*</)?.[1]?.split(/\s+via\s+/i)[0]?.trim();
  if (!display || display.includes("@")) return null;
  const stripped = display.replace(GENERIC_NAME_WORDS_RE, " ").replace(/[-–—|,:]+/g, " ").replace(/\s+/g, " ").trim();
  if (!stripped || VENDOR_NAMES_RE.test(stripped)) return null;
  const hadGenericWord = stripped !== display.replace(/\s+/g, " ").trim();
  if (!hadGenericWord && stripped.split(" ").length > 1) return null;
  return stripped.length <= 60 ? stripped : null;
}

/**
 * The hiring company an automated email is about, by rule, or null to say "ask the model".
 *
 * Never the sender's domain when that domain is an ATS vendor's — every Workday tenant mails
 * from `myworkday.com`, which is how one board once filed Mastercard and AMD under "Myworkday".
 * First match wins, most explicit first.
 */
export function atsCompanyOf(mail: { from: string; subject: string; text: string }): string | null {
  const parsed = parseFromHeader(mail.from);
  const domain = parsed?.email.split("@")[1] ?? "";
  const local = parsed?.email.split("@")[0] ?? "";

  const fromSubject = firstMatch(mail.subject, SUBJECT_PATTERNS);
  if (fromSubject) return fromSubject;

  if (TENANT_LOCAL_PART_DOMAINS.some((d) => domain === d || domain.endsWith(`.${d}`))) {
    const token = local.toLowerCase().replace(/[^a-z]/g, "");
    if (token.length >= 2 && !AUTOMATED_LOCAL_PARTS.test(local) && !ROLE_LOCAL_PARTS.test(local) && !VENDOR_NAMES_RE.test(token)) {
      return fromToken(token);
    }
  }

  const fromName = companyFromDisplayName(mail.from);
  if (fromName) return fromName;

  const fromBody = firstMatch(mail.text, BODY_PATTERNS);
  if (fromBody) return fromBody;

  // A role address on the company's own domain: careers@stripe.com.
  if (domain && !isAtsVendorDomain(domain)) return firmFromEmail(parsed!.email);
  return null;
}
