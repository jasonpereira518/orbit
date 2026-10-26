export type OutreachChannel = "email" | "linkedin" | "sms";

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

export type SequenceStep = {
  delayDays: number;
  intent?: string;
};

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

export type OutreachSearchSource = "demo" | "apollo";

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

export const OUTREACH_CHANNELS: OutreachChannel[] = ["email", "linkedin", "sms"];

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
  book_intro: "Book an intro / call",
  ask_referral: "Ask for a referral",
  get_feedback: "Get feedback",
  explore_partnership: "Explore a partnership",
  other: "Other (from message intent)",
};

export const OUTCOME_LABELS: Record<OutreachMessageOutcome, string> = {
  replied: "Replied",
  positive_reply: "Positive reply",
  negative_reply: "Negative reply",
  neutral_reply: "Neutral / other reply",
  bounced: "Bounced",
  unsubscribed: "Unsubscribed",
};

export const BULK_SEND_LIMIT = 25;
export const DAILY_SEND_LIMIT = 50;

/** Contacts refreshed per server action call (sequential people/match + photo fetch). */
export const LINKEDIN_REFRESH_BATCH_SIZE = 3;

export const DEFAULT_SEQUENCE_STEPS: SequenceStep[] = [
  { delayDays: 3, intent: "Polite follow-up referencing the first note" },
  { delayDays: 7, intent: "Final short bump with a clear opt-out" },
];

/**
 * Addresses that must never be mailed, whatever the caller believes.
 *
 * `example.com` / `.example` / `.invalid` / `.test` / `.localhost` are reserved by RFC
 * 2606 and RFC 6761 precisely so they cannot resolve — every message to one is a
 * guaranteed hard bounce, and enough of those cost a shared sending domain its
 * reputation. Orbit's own demo prospects use them.
 */
export function isUnmailableAddress(email: string) {
  const domain = email.trim().toLowerCase().split("@")[1] ?? "";
  if (!domain) return true;
  return /(^|\.)(example\.(com|net|org)|example|invalid|test|localhost)$/.test(domain);
}

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
