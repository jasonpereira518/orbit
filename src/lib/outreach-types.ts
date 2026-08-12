export type OutreachChannel = "email" | "linkedin" | "sms";

export type OutreachMessageStatus =
  | "draft"
  | "generated"
  | "copied"
  | "opened"
  | "sent"
  | "failed"
  | "skipped"
  | "scheduled";

export type OutreachMessageOutcome =
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
  /** positive replies / (sent − bounced); null when no eligible sends */
  successfulReplyRate: number | null;
};

export type PipelineFilter =
  | "all"
  | "needs_draft"
  | "ready"
  | "sent"
  | "awaiting_reply"
  | "replied"
  | "closed"
  | "follow_up_due";

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
