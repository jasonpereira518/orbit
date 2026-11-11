import { nameKey } from "./key";

/**
 * What a "name" a source handed us actually is. Callers set policy by verdict; nothing else in
 * the app should carry its own person-or-not regex.
 *
 * `certain` marks the verdicts that are safe to act on with no human: a legal suffix, a machine
 * mailbox, a calendar room, an email or phone typed where a name goes. Word-list hits ("Growth
 * Team", "IBM") are likely, never certain: "Ann Calendar" and "ANNA" are people.
 */
export type NameVerdict =
  | "person_full"
  | "person_partial"
  | "handle"
  | "email"
  | "phone"
  | "organization"
  | "mailbox"
  | "placeholder"
  | "group";

export type NameClass = { verdict: NameVerdict; certain: boolean };

// ── Mailboxes ─────────────────────────────────────────────────────────────────────────

/** Machine senders: nothing behind them replies. `isAutomatedAddress`'s list. */
export const AUTOMATED_LOCAL_PARTS = new Set([
  "noreply", "no-reply", "donotreply", "do-not-reply", "notifications", "notification",
  "mailer-daemon", "postmaster", "bounce", "bounces", "automated", "alerts",
]);

/** `AUTOMATED_LOCAL_PARTS` plus calendar and invite senders: never a person. */
export const MACHINE_LOCAL_PARTS = [
  ...new Set([
    ...AUTOMATED_LOCAL_PARTS,
    ...["noreply", "no-reply", "donotreply", "do-not-reply", "calendar", "invite", "invites", "event", "events"],
    ...["notification", "notifications", "mailer", "mailer-daemon", "bounce", "bounces", "postmaster", "updates"],
  ]),
];
const MACHINE_SET = new Set(MACHINE_LOCAL_PARTS);

/**
 * Shared inboxes that belong to an organisation, not one person. FROZEN: `identityKeysFor`
 * refuses these as email identities, so widening or narrowing it re-keys stored
 * `contact_identities` rows (`smoke-contact-resolve`, `smoke-names`).
 */
export const ROLE_EMAIL_LOCALS = new Set([
  "info", "hello", "hi", "contact", "contactus", "admin", "support", "help", "sales", "team",
  "office", "mail", "email", "enquiries", "inquiries", "billing", "accounts", "accounting",
  "finance", "hr", "jobs", "careers", "recruiting", "press", "media", "marketing", "legal",
  "privacy", "security", "abuse", "postmaster", "webmaster", "noreply", "no-reply", "donotreply",
  "do-not-reply", "notifications", "newsletter", "subscriptions",
]);

// ── Calendar rooms (shared with the SQL twin in non-person-participant.ts) ─────────────

/** group.calendar.google.com, resource.calendar.google.com, import.calendar.google.com. */
export const CALENDAR_DOMAIN = "@(.+\\.)?calendar\\.google\\.com$";
/**
 * "Calendar" as a whole word, only with a digit or three+ words around it, so "Ann Calendar"
 * passes while "Interview Calendar 2" does not. No `\b`, so one pattern serves JS and SQL.
 */
export const CALENDAR_WORD = "(^|[^a-z0-9])calendar($|[^a-z0-9])";
export const CALENDAR_CONTEXT = "[0-9]|^[[:space:]]*[^[:space:]]+[[:space:]]+[^[:space:]]+[[:space:]]+[^[:space:]]";
export const ROOM_PHRASE = "(^|[^a-z0-9])(conference|meeting) room($|[^a-z0-9])";
export const jsRe = (pattern: string) => new RegExp(pattern.replaceAll("[:space:]", "\\s"), "i");

/** A calendar or meeting room by its name alone ("Interview Calendar 2", "Conference Room B"). */
export function isRoomName(name: string | null | undefined): boolean {
  const n = (name ?? "").trim();
  return jsRe(ROOM_PHRASE).test(n) || (jsRe(CALENDAR_WORD).test(n) && jsRe(CALENDAR_CONTEXT).test(n));
}

/** The local part of an address without its `+tag`: `ada+github@x.com` is still Ada. */
export function mailboxLocal(email: string | null | undefined): string {
  return (email ?? "").trim().toLowerCase().split("@")[0]!.split("+")[0]!;
}

/** person | role (a shared inbox, may be one person on a founder's domain) | machine. */
export function classifyMailbox(email: string | null | undefined): "person" | "role" | "machine" | null {
  const e = (email ?? "").trim().toLowerCase();
  if (!e.includes("@")) return null;
  const local = mailboxLocal(e);
  if (MACHINE_SET.has(local) || jsRe(CALENDAR_DOMAIN).test(e)) return "machine";
  return ROLE_EMAIL_LOCALS.has(local) ? "role" : "person";
}

// ── Names ─────────────────────────────────────────────────────────────────────────────

/** A stored name that is really an address handle: "", "dmcraver" for dmcraver@…, "calvintwong25". */
export function isHandle(name: string | null | undefined, email?: string | null): boolean {
  const n = (name ?? "").trim();
  if (!n) return true;
  if (email && n.toLowerCase() === email.split("@")[0]?.toLowerCase()) return true;
  return !/\s/.test(n) && /[\d._@]/.test(n);
}

/** Names that name nobody, including the placeholders Orbit itself used to write. Keyed. */
export const PLACEHOLDER_NAMES = new Set([
  "linkedin member", "linkedin contact", "linkedin user", "member", "unknown", "unknown contact",
  "user", "none", "n a", "na", "null", "undefined", "unnamed", "no name", "contact", "guest",
  "attendee", "participant", "someone", "anonymous", "private", "test", "me", "you", "myself",
]);
const NUMBERED_PLACEHOLDER = /^(executive candidate|speaker|guest|attendee|participant|caller|user|contact|person) ?\d+$/;

const ARTICLES = new Set(["the", "a", "an", "my", "our", "their", "his", "her"]);
/** A job or role standing where a name goes: "the recruiter", "Hiring Manager", "CEO". */
const ROLE_WORDS = new Set([
  "new", "head", "of", "senior", "junior", "lead", "chief", "recruiter", "recruiters",
  "recruiting", "hiring", "manager", "director", "founder", "cofounder", "co", "ceo", "cto",
  "cfo", "coo", "vp", "president", "engineer", "designer", "intern", "investor", "partner",
  "associate", "analyst", "professor", "advisor", "mentor", "boss", "colleague", "coworker",
  "speaker", "host", "organizer", "panelist", "interviewer", "candidate", "assistant", "team",
  "talent", "sourcer", "staff", "officer",
]);

/** Legal forms. On their own word in a multi-word name, a company and nothing else. */
const LEGAL_SUFFIX = new Set([
  "inc", "incorporated", "llc", "ltd", "limited", "llp", "plc", "gmbh", "corp", "corporation", "pty",
]);

/** Words a company, team or school name carries and a person's name almost never does. */
const ORG_WORDS = new Set([
  "company", "labs", "lab", "group", "capital", "ventures", "partners", "holdings", "fund",
  "university", "college", "school", "institute", "academy", "team", "foundation", "bank",
  "technologies", "technology", "systems", "solutions", "studio", "studios", "agency",
  "consulting", "media", "network", "association", "club", "society", "hq", "committee",
  "department", "combinator",
  // Departments: "Acme Support", "Stripe Recruiting", "Customer Service".
  "support", "sales", "marketing", "careers", "recruiting", "recruitment", "billing", "hr",
  "helpdesk", "notifications", "newsletter", "service", "services", "operations", "admissions",
  "acquisition", "resources", "recruiters", "mailer", "admin", "info", "noreply",
]);

/** Single CJK / Hangul names are written without a space between family and given name. */
const CJK_FULL_NAME = /^[\p{Script=Han}\p{Script=Hangul}]{2,4}$/u;

/** "Jane & John", "Jane and John", "Ann + Raj": two people in one name field. */
const JOINER = /\s*(?:&|\+|\sand\s)\s*/i;

/**
 * What `raw` is, read with what we know about the record. `company`: the record's own company
 * (a "person" called exactly that is the company). `email`: its address.
 */
export function classifyName(
  raw: string | null | undefined,
  ctx: { email?: string | null; company?: string | null } = {}
): NameClass {
  const n = (raw ?? "").replace(/\s+/g, " ").trim();
  const mailbox = classifyMailbox(ctx.email);
  if (mailbox === "machine") return { verdict: "mailbox", certain: true };
  if (!n) return { verdict: "placeholder", certain: true };
  if (/^\S+@\S+\.\S+$/.test(n)) return { verdict: "email", certain: true };
  if (!/\p{L}/u.test(n)) {
    return n.replace(/\D/g, "").length >= 7 ? { verdict: "phone", certain: true } : { verdict: "placeholder", certain: true };
  }
  if (isRoomName(n)) return { verdict: "mailbox", certain: true };

  const key = nameKey(n);
  const words = key.split(" ");
  if (PLACEHOLDER_NAMES.has(key) || NUMBERED_PLACEHOLDER.test(key)) return { verdict: "placeholder", certain: true };
  if (words.length > 1 && words.some((w) => LEGAL_SUFFIX.has(w))) return { verdict: "organization", certain: true };
  // A shared inbox named after itself ("support" <support@acme.com>).
  if (mailbox === "role" && (isHandle(n, ctx.email) || ROLE_EMAIL_LOCALS.has(key))) {
    return { verdict: "mailbox", certain: false };
  }
  if (ctx.company && key === nameKey(ctx.company)) return { verdict: "organization", certain: false };
  if (words.some((w) => ORG_WORDS.has(w))) return { verdict: "organization", certain: false };
  const content = words.filter((w) => !ARTICLES.has(w));
  if (content.length && content.every((w) => ROLE_WORDS.has(w))) return { verdict: "placeholder", certain: false };
  // "Y Combinator 2024", "jsmith42", "@jane": a number or an @ is never part of a person's name.
  if (/[@\d]/.test(n) || isHandle(n, ctx.email)) return { verdict: "handle", certain: false };
  // "IBM", "AWS", "YC": a lone acronym is an organisation far more often than a person.
  if (/^[A-Z]{3,6}$/.test(n)) return { verdict: "organization", certain: false };
  const parts = n.split(JOINER).filter((p) => /\p{L}/u.test(p));
  if (parts.length > 1) return /&/.test(n) ? { verdict: "organization", certain: false } : { verdict: "group", certain: false };
  // "Doe, Jane" and "Jane Doe, PhD" are one person; "Jane, Alex, Sam" is a list.
  if (n.split(",").length > 2) return { verdict: "group", certain: false };
  if (!/\s/.test(n) && n.length > 20) return { verdict: "handle", certain: false };
  if (CJK_FULL_NAME.test(n)) return { verdict: "person_full", certain: false };
  const named = words.filter((w) => /\p{L}{2}/u.test(w));
  return { verdict: named.length >= 2 ? "person_full" : "person_partial", certain: false };
}

/** A person's name, whole or partial: what a contact may be called. */
export function isPersonName(raw: string | null | undefined, ctx?: { email?: string | null; company?: string | null }): boolean {
  const { verdict } = classifyName(raw, ctx);
  return verdict === "person_full" || verdict === "person_partial";
}
