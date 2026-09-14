/** Shared data contract. Safe to import from the Chrome extension. */
export type Channel = "email" | "linkedin";
export type Transport =
  "gmail" | "outlook" | "gmail_web" | "outlook_web" | "linkedin";
export type Sender = {
  transport: Transport;
  address: string;
  introduction: string;
  signature: string;
  invitationLimit: 200 | 300;
};
export type Criterion = {
  field: "title" | "company" | "location" | "experience";
  value: string;
  importance: "required" | "preferred" | "excluded";
};
export type Brief = {
  description: string;
  outcome: string;
  criteria: Criterion[];
  confirmed: boolean;
  batchInstructions: string;
};
export type Evidence = {
  url: string;
  title: string;
  excerpt: string;
  fetchedAt: string;
};
export type Research = {
  conflicts?: string[];
  identities: string[];
  evidence: Evidence[];
  score: number;
  reasons: string[];
  confidence: "low" | "medium" | "high";
  emailStatus: "verified" | "published" | "unknown" | "invalid";
  eligibility: "match" | "uncertain" | "mismatch";
  priorOutreach?: boolean;
  ambiguous?: boolean;
};
export type Candidate = {
  fullName: string;
  title: string | null;
  company: string | null;
  location: string | null;
  email: string | null;
  linkedinUrl: string | null;
  externalId: string;
  research: Research;
};
export type ExecutionStatus =
  | "idle"
  | "queued"
  | "sending"
  | "accepted"
  | "confirmed"
  | "needs_verification"
  | "failed"
  | "cancelled";
export type MessageKind = "initial" | "follow_up" | "reply";
export type JobPayload = {
  baseMessageId?: string;
  revision?: number;
  messageId?: string;
  prospectId?: string;
  funding?: "hosted" | "personal";
  limit?: number;
  candidate?: Candidate;
  instructions?: string;
  step?: string;
};
export type MailCursor = {
  historyId?: string;
  nextPage?: string;
  deltaLink?: string;
  sentDeltaLink?: string;
  sentPageLink?: string;
  pageLink?: string;
};
export type BrowserTask = {
  jobId: string;
  leaseToken: string;
  campaignId: string;
  messageId: string;
  kind: MessageKind;
  sender: Sender;
  recipient: string;
  recipientName: string;
  profileUrl: string | null;
  subject: string;
  body: string;
  revision: number;
  conversationUrl: string | null;
};
export type BrowserObservation = {
  externalId: string;
  direction: "inbound" | "outbound";
  body: string;
  subject?: string;
  sentAt: string;
  kind: "human" | "automatic" | "bounce" | "accepted";
  conversationUrl: string;
};
export type BrowserCheckpoint = {
  phase: "prepared" | "clicked" | "confirmed" | "failed" | "needs_verification";
  sender: string;
  recipient: string;
  subject: string;
  body: string;
  evidence?: string;
  conversationUrl?: string;
};
