/**
 * The single list of opportunity kinds every producer and reader goes through, plus the
 * repair layer that turns a model's near-miss vocabulary into one of them.
 *
 * Deliberately NO `lucide-react` import, unlike `src/lib/interaction-types.ts`: this module
 * is reached from `src/lib/ai.ts` and from the extraction path, both of which run
 * server-side and are driven by `tsx` smoke scripts with no bundler. Icons belong to the
 * component that renders a row, not to the vocabulary.
 *
 * The unions themselves live in `@/db/schema` beside the column that stores them — the same
 * split `reminder-action-kind.ts` already uses — so a kind added here and forgotten there
 * cannot type-check.
 */
import type {
  OpportunityDirection,
  OpportunityKind,
  OpportunityStatus,
} from "@/db/schema";

export type { OpportunityDirection, OpportunityKind, OpportunityStatus };

export const OPPORTUNITY_KINDS = [
  { value: "internship", label: "Internship", hint: "A named internship or co-op" },
  { value: "job", label: "Role", hint: "A specific open role" },
  { value: "referral", label: "Referral", hint: "They would put your name forward" },
  { value: "introduction", label: "Introduction", hint: "They would connect you to someone" },
  { value: "startup_lead", label: "Startup lead", hint: "A company or idea worth chasing" },
  { value: "mentor", label: "Mentorship", hint: "Ongoing guidance, not a one-off" },
  { value: "investor", label: "Investor", hint: "They invest, or know who does" },
  { value: "speaker", label: "Speaking", hint: "A talk, panel or podcast" },
  { value: "customer", label: "Customer", hint: "A buyer or design partner" },
  { value: "collaboration", label: "Collaboration", hint: "Building something together" },
  { value: "advice", label: "Advice", hint: "Domain expertise you can draw on" },
  { value: "other", label: "Opportunity", hint: "Worth remembering, hard to file" },
] as const satisfies readonly { value: OpportunityKind; label: string; hint: string }[];

/**
 * Ordered open-first, because the profile section renders them in this order and the states
 * worth acting on belong at the top.
 *
 * `tone` is a semantic name, not a colour: the component picks the class. A palette that
 * lives in the vocabulary module is a palette that gets imported by server code.
 */
export const OPPORTUNITY_STATUSES = [
  { value: "open", label: "Open", tone: "open" },
  { value: "in_progress", label: "In progress", tone: "active" },
  { value: "landed", label: "Landed", tone: "good" },
  { value: "passed", label: "Passed", tone: "bad" },
  { value: "dismissed", label: "Dismissed", tone: "muted" },
] as const satisfies readonly {
  value: OpportunityStatus;
  label: string;
  tone: "open" | "active" | "good" | "bad" | "muted";
}[];

/** The statuses that still want something from you — and the only ones the mirror carries. */
export const OPEN_OPPORTUNITY_STATUSES: readonly OpportunityStatus[] = ["open", "in_progress"];

/** Kinds the job feed watches. A posting only ever matches a contact holding one of these. */
export const JOB_SIGNAL_KINDS: readonly OpportunityKind[] = ["internship", "referral"];

const KIND_VALUES = new Set<string>(OPPORTUNITY_KINDS.map((k) => k.value));
const STATUS_VALUES = new Set<string>(OPPORTUNITY_STATUSES.map((s) => s.value));

/**
 * Model output that is right in spirit and wrong in vocabulary.
 *
 * Worth having rather than tightening the prompt: the two-pass extraction sends the same
 * shape to three different providers, and each has its own favourite synonym. Mapping on
 * read costs one lookup; a stricter prompt costs a retry and still misses.
 *
 * Mapped on the way IN only. Nothing writes an alias to the database.
 */
const KIND_ALIASES: Record<string, OpportunityKind> = {
  intro: "introduction",
  warm_intro: "introduction",
  connection: "introduction",
  connect: "introduction",
  job_referral: "referral",
  refer: "referral",
  refers: "referral",
  full_time: "job",
  fulltime: "job",
  role: "job",
  position: "job",
  opening: "job",
  new_grad: "job",
  coop: "internship",
  co_op: "internship",
  summer_internship: "internship",
  intern: "internship",
  mentorship: "mentor",
  coach: "mentor",
  coaching: "mentor",
  advisor: "mentor",
  funding: "investor",
  angel: "investor",
  vc: "investor",
  investment: "investor",
  talk: "speaker",
  panel: "speaker",
  podcast: "speaker",
  speaking: "speaker",
  client: "customer",
  design_partner: "customer",
  pilot: "customer",
  sale: "customer",
  partnership: "collaboration",
  partner: "collaboration",
  collab: "collaboration",
  cofounder: "startup_lead",
  co_founder: "startup_lead",
  idea: "startup_lead",
  startup: "startup_lead",
  expertise: "advice",
  guidance: "advice",
};

/**
 * Language that means "this person will get my name in front of someone who hires".
 *
 * Deterministic, and it OVERRIDES whatever kind the model chose. A referral is the single
 * most valuable thing a conversation can produce and the thing people go looking for by name
 * later — "who can refer me?" — so leaving the label to a model that calls it an
 * `introduction` one time in five makes the search that matters unreliable.
 *
 * Split into two families because they fail differently:
 *
 *   DIRECT — the person says they will pass your name or your resume along. Unambiguous.
 *   HIRING CONTACT — the person will find, know, or reach the hiring manager or recruiter.
 *     This would otherwise classify as `introduction`, and on the plain meaning of the words
 *     it IS one. It is filed under referral anyway, deliberately: what the user will search
 *     for months later is "referral", and an introduction *to the person who hires* is a
 *     referral in everything but grammar.
 *
 * Both require a VERB. Bare "hiring manager" is a job title — "she is a hiring manager" says
 * nothing about you — and bare "refer" appears in "referring to the docs" and "referred to
 * as", neither of which is an offer.
 */
const REFERRAL_DIRECT_RE = new RegExp(
  [
    // "a referral", "internal referral", "refer me", "can refer you", "referred me in"
    String.raw`\breferrals?\b`,
    String.raw`\brefer(?:ring|red|s)?\s+(?:me|us|you|him|her|them)\b`,
    // a resume, CV or application moving through them
    String.raw`\b(?:forward|pass|send|share|push|submit|flag|drop|hand)\w*\s+(?:\w+\s+){0,3}(?:resume|cv|résumé|application|profile|name)\b`,
    String.raw`\b(?:resume|cv|résumé|application)\s+(?:\w+\s+){0,3}(?:forward|along|internally|to the team)\b`,
    // social-capital phrasings
    String.raw`\bput\s+(?:my|your|his|her|their)\s+name\s+(?:forward|in|up)\b`,
    String.raw`\bput\s+in\s+a\s+good\s+word\b`,
    String.raw`\bvouch\s+for\b`,
    String.raw`\brecommend\s+(?:me|us|you|him|her|them)\b`,
    String.raw`\bget\s+(?:me|us|you)\s+in\s+front\s+of\b`,
  ].join("|"),
  "i"
);

/** Who counts as "the person who does the hiring". */
const HIRING_CONTACT_RE =
  /\b(?:hiring\s+manager|recruiter|talent\s+(?:acquisition|partner)|head\s+of\s+(?:talent|recruiting))\b/i;

/**
 * The verb that turns a job title into an offer. Without one, "she is a hiring manager" —
 * a fact about her job — would read as an offer to help with yours.
 */
const HIRING_ACTION_RE =
  /\b(?:find|finds|finding|introduce|intro|connect|connects|connecting|knows?|reach|reaches|reaching|talks?|speaks?|ping|email|put\s+(?:me|us|you)\s+in\s+touch|loop\s+(?:me|us|you)\s+in|get\s+(?:me|us|you))\b/i;

/**
 * Whether this text describes a referral, whatever the model called it.
 *
 * Takes the label AND the verbatim excerpt: the label is compressed ("summer internship") and
 * the offer usually lives in the sentence ("she said she'd find the hiring manager").
 */
export function looksLikeReferral(...parts: (string | null | undefined)[]): boolean {
  const text = parts.filter(Boolean).join(" ").replace(/\s+/g, " ");
  if (!text.trim()) return false;
  if (REFERRAL_DIRECT_RE.test(text)) return true;
  return HIRING_CONTACT_RE.test(text) && HIRING_ACTION_RE.test(text);
}

function normalizeToken(raw: string): string {
  return raw
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

export function isOpportunityKind(value: string): value is OpportunityKind {
  return KIND_VALUES.has(value);
}

/**
 * Any string to a kind we store. Never throws and never returns null: an unrecognised kind
 * becomes `"other"`, because the opportunity itself is still real and dropping the row to
 * punish a bad label loses the user's data, not the model's.
 */
export function normalizeOpportunityKind(raw: string | null | undefined): OpportunityKind {
  const token = normalizeToken(raw ?? "");
  if (!token) return "other";
  if (isOpportunityKind(token)) return token;
  return KIND_ALIASES[token] ?? "other";
}

export function normalizeOpportunityStatus(raw: string | null | undefined): OpportunityStatus {
  const token = normalizeToken(raw ?? "");
  return STATUS_VALUES.has(token) ? (token as OpportunityStatus) : "open";
}

export function normalizeOpportunityDirection(
  raw: string | null | undefined
): OpportunityDirection | null {
  const token = normalizeToken(raw ?? "");
  return token === "they_offer" || token === "you_ask" ? token : null;
}

/**
 * Label for a kind read back out of the database.
 *
 * Takes `string`, not `OpportunityKind`, on purpose. The column is plain `text`, so a row
 * written by a newer deploy can reach an older client; falling back to the generic label
 * keeps that row readable instead of rendering an empty chip.
 */
export function opportunityKindLabel(raw: string | null | undefined): string {
  const kind = normalizeOpportunityKind(raw);
  return OPPORTUNITY_KINDS.find((k) => k.value === kind)?.label ?? "Opportunity";
}

export function opportunityStatusLabel(raw: string | null | undefined): string {
  const status = normalizeOpportunityStatus(raw);
  return OPPORTUNITY_STATUSES.find((s) => s.value === status)?.label ?? "Open";
}

export function isOpenOpportunityStatus(status: string): boolean {
  return (OPEN_OPPORTUNITY_STATUSES as readonly string[]).includes(status);
}

/** Bounds a label at the point it is written, read and rendered. */
export const MAX_OPPORTUNITY_LABEL_CHARS = 140;

export function normalizeOpportunityLabel(raw: string | null | undefined): string {
  return (raw ?? "").replace(/\s+/g, " ").trim().slice(0, MAX_OPPORTUNITY_LABEL_CHARS);
}

/**
 * The strings written to `contacts.opportunities`, the denormalised mirror.
 *
 * That column predates this table and has four readers that should not have to join:
 * `conversation-starters.ts`, the contact embedding in `search.ts`, the browser extension
 * panel, and the admin view. They all expect one human-readable line per live opportunity,
 * so the kind is prefixed rather than carried separately — "Referral — could forward my
 * resume" reads correctly everywhere a bare label would have lost its type.
 *
 * Closed opportunities are excluded: a mirror of things you are no longer chasing would
 * make conversation starters suggest a dead thread, which is worse than saying nothing.
 */
export function opportunityMirrorLabels(
  rows: readonly { kind: string; label: string; status: string }[]
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    if (!isOpenOpportunityStatus(row.status)) continue;
    const label = normalizeOpportunityLabel(row.label);
    if (!label) continue;
    const line = `${opportunityKindLabel(row.kind)} — ${label}`;
    const key = line.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(line);
  }
  return out;
}
