export type OutreachChannel = "email" | "linkedin";

export type OutreachMessageStatus =
  | "draft"
  | "generated"
  | "queued"
  | "unsure"
  | "copied"
  | "opened"
  | "sent"
  | "failed"
  | "skipped"
  | "scheduled";

export type OutreachMessageOutcome =
  | "replied"
  | "positive_reply"
  | "negative_reply"
  | "neutral_reply"
  | "bounced"
  | "unsubscribed";

export type AudienceFilters = {
  titles?: string[];
  locations?: string[];
  industries?: string[];
  keywords?: string;
  seniorities?: string[];
  /** Employer names extracted from the audience query, e.g. ["Capital One"] */
  organizationNames?: string[];
  /** Employer domains, e.g. ["capitalone.com"] */
  organizationDomains?: string[];
};

export type NormalizedProspect = {
  externalId: string;
  fullName: string;
  title: string | null;
  company: string | null;
  email: string | null;
  phone: string | null;
  linkedinUrl: string | null;
  location: string | null;
  enrichment: Record<string, unknown>;
};

export type CampaignMetrics = {
  prospectCount: number;
  selectedCount: number;
  sentCount: number;
  bouncedCount: number;
  replyCount: number;
  positiveReplyCount: number;
  negativeReplyCount: number;
  awaitingReplyCount: number;
  pendingFollowUpCount: number;
  /** Replies of any tone / (sent − bounced); null when nothing eligible was sent. */
  replyRate: number | null;
};

/** Where a person is in a campaign; `prospectPipelineBucket` assigns one, `all` is the unfiltered view. */
export type PipelineFilter =
  | "all"
  | "needs_info"
  | "needs_draft"
  | "ready"
  | "waiting"
  | "follow_up_due"
  | "replied"
  | "failed";

export const OUTREACH_CHANNELS: OutreachChannel[] = ["email", "linkedin"];

export const OUTREACH_TONES = [
  "professional",
  "friendly",
  "casual",
  "direct",
] as const;

export const OUTREACH_REPLY_CTAS = [
  "book_intro",
  "ask_referral",
  "get_feedback",
  "explore_partnership",
  "other",
] as const;

export type OutreachReplyCta = (typeof OUTREACH_REPLY_CTAS)[number];

export const REPLY_CTA_LABELS: Record<OutreachReplyCta, string> = {
  book_intro: "A short chat",
  ask_referral: "A referral",
  get_feedback: "Advice on a question",
  explore_partnership: "Exploring working together",
  other: "Something else",
};

/**
 * The audience line under a campaign's title, or null when the title already says it.
 *
 * A new campaign is named with its audience cut to 60 characters, so the name is either the
 * audience or the start of a longer one; saying it again right under the title is noise.
 * Compared trimmed, with runs of spaces collapsed (the cut collapses them too), ignoring case.
 */
export function audienceSubtitle(name: string, audience: string | null | undefined): string | null {
  const shown = (audience ?? "").trim();
  if (!shown) return null;
  const squash = (text: string) => text.replace(/\s+/g, " ").trim().toLowerCase();
  const title = squash(name);
  const full = squash(shown);
  const repeats = title !== "" && (title === full || (full.length > 60 && full.startsWith(title)));
  return repeats ? null : shown;
}

export const OUTCOME_LABELS: Record<OutreachMessageOutcome, string> = {
  replied: "Replied",
  positive_reply: "Positive reply",
  negative_reply: "Negative reply",
  neutral_reply: "Neutral / other reply",
  bounced: "Bounced",
  unsubscribed: "Unsubscribed",
};

export const BULK_SEND_LIMIT = 25;

/** Contacts refreshed per server action call (sequential people/match + photo fetch). */
export const LINKEDIN_REFRESH_BATCH_SIZE = 3;

/**
 * Message statuses that mean Orbit (or the person) already reached out. `opened` is a delivered
 * status on legacy rows; `unsure` means "may have sent". Someone with one stays on the list.
 */
export const CONTACTED_STATUSES: readonly string[] = ["queued", "sent", "copied", "opened", "unsure"];
/** Email messages that tie a thread to the address it went to, or may have. The address then stays. */
export const EMAILED_STATUSES: readonly string[] = ["queued", "sent", "unsure"];

/** LinkedIn messages that mean the note went out, or was copied to send. The link then stays. */
export const LINKEDIN_CONTACTED_STATUSES: readonly string[] = ["copied", "sent", "opened"];

export type ProspectOrigin = "find" | "manual" | "brief" | "legacy";

/** What `outreach_prospects.enrichment` holds for people added since this plan. */
export type ProspectEnrichment = {
  origin?: ProspectOrigin;
  /** The page that shows the match. Shown as a link; Orbit never fetches it. */
  url?: string | null;
  whyMatches?: string | null;
  /** `ai_result_cache` key of a person brief (`research.person`). */
  researchKey?: string | null;
  emailSource?: "contact" | "user" | null;
  demo?: boolean;
};

/**
 * The parts of a stored `enrichment` a page may show, each checked. Older rows hold whatever
 * the search provider returned, so nothing is trusted by name alone, and a link must be http(s)
 * before it becomes an `href`.
 */
export function readEnrichment(raw: unknown): ProspectEnrichment {
  const e = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const text = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);
  const url = text(e.url);
  return {
    origin: e.origin === "find" || e.origin === "manual" || e.origin === "brief" || e.origin === "legacy" ? e.origin : undefined,
    url: url && /^https?:\/\//i.test(url) ? url : null,
    whyMatches: text(e.whyMatches),
    researchKey: text(e.researchKey),
    emailSource: e.emailSource === "contact" || e.emailSource === "user" ? e.emailSource : null,
  };
}

export type NewProspect = {
  fullName: string;
  title: string | null;
  company: string | null;
  email: string | null;
  linkedinUrl: string | null;
  location: string | null;
  origin: "find" | "manual" | "brief";
  url: string | null;
  whyMatches: string | null;
  researchKey: string | null;
};

export const MAX_CAMPAIGN_PEOPLE = 100;
/** Campaigns the "Add to campaign" menu on /find lists: the most recently updated ones. */
export const MAX_CAMPAIGN_CHOICES = 20;

/** A campaign as /find offers it: enough to pick one and say where it sends. */
export type CampaignChoice = { id: string; name: string; channel: "email" | "linkedin" };
/** People drafted in one go: each is a model call. */
export const MAX_DRAFTS_PER_RUN = 10;
/** LinkedIn's connection-note limit. */
export const LINKEDIN_NOTE_MAX = 300;
/** People looked up in the mailbox in one "check for replies" pass: each is a provider call. */
export const REPLY_CHECKS_PER_PASS = 25;
/** A send older than this is no longer checked for a reply. */
export const REPLY_CHECK_WINDOW_DAYS = 60;
/** How long a sent first message waits, unanswered, before a follow-up is due. */
export const FOLLOW_UP_AFTER_DAYS = 7;
