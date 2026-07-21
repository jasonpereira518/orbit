export type OutreachChannel = "email" | "linkedin" | "sms";

export type OutreachCampaignStatus =
  | "draft"
  | "active"
  | "completed"
  | "archived";

export type OutreachProspectStatus =
  | "suggested"
  | "selected"
  | "excluded"
  | "contacted";

export type OutreachMessageStatus =
  | "draft"
  | "generated"
  | "copied"
  | "opened"
  | "sent"
  | "failed"
  | "skipped";

export type AudienceFilters = {
  titles?: string[];
  locations?: string[];
  industries?: string[];
  keywords?: string;
  seniorities?: string[];
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

export const OUTREACH_CHANNELS: OutreachChannel[] = ["email", "linkedin", "sms"];

export const OUTREACH_TONES = [
  "professional",
  "friendly",
  "casual",
  "direct",
] as const;

export const BULK_SEND_LIMIT = 25;
export const DAILY_SEND_LIMIT = 50;

/** Contacts refreshed per server action call (sequential people/match + photo fetch). */
export const LINKEDIN_REFRESH_BATCH_SIZE = 3;
