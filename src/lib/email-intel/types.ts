import type { RecruiterStage } from "@/lib/recruiter-stages";

/** What triage decided about a thread. `skipped` threads are remembered so they are never re-fetched. */
export type ThreadDecision = "ats_rule" | "classify" | "skipped";

/** `pending_ai` waits for the P2 extractor; `claimed` and `failed` are its lifecycle. */
export type EmailThreadStatus = "done" | "pending_ai" | "skipped" | "claimed" | "failed";

export type EmailEventKind = "job_posting" | "process_update" | "news" | "event" | "other";

export type EmailEventPerson = {
  name: string | null;
  email: string | null;
  title: string | null;
  /**
   * Never written to storage. A contact id inside this JSON column would go stale on merge
   * and unmerge; `resolvePeople` (`resolve.ts`) looks the address up when it is read.
   */
  contactId?: string | null;
};

/** A hiring-stage event read from an automated template by rule, never by a model. */
export type RuleEvent = {
  kind: "process_update";
  stage: RecruiterStage;
  company: string | null;
  summary: string;
  /** Gmail's own preview line, at most 200 characters. Never a body. */
  evidenceQuote: string;
  occurredAt: Date;
  confidence: number;
};

export type ThreadResult = {
  threadId: string;
  lastMessageId: string;
  /** Empty for skipped threads: nothing about a judged-irrelevant thread is kept beyond its id. */
  subject: string;
  participants: string[];
  lastDirection: "in" | "out";
  decision: ThreadDecision;
  triageScore: number;
  event: RuleEvent | null;
};

export function statusFor(decision: ThreadDecision): EmailThreadStatus {
  if (decision === "classify") return "pending_ai";
  if (decision === "skipped") return "skipped";
  return "done";
}

/** One message as the extractor reads it: text only, already cut. Never stored. */
export type EmailIntelMessage = {
  from: string;
  to: string;
  subject: string;
  /** Epoch ms, or null when Gmail gave none. */
  date: number | null;
  body: string;
};

/** An event the model found and TypeScript kept. */
export type ExtractedEvent = {
  kind: Exclude<EmailEventKind, "other">;
  company: string | null;
  role: string | null;
  stage: RecruiterStage | null;
  summary: string;
  /** Copied from the mail, at most 200 characters, verified against it. */
  evidenceQuote: string;
  occurredAt: Date;
  dueAt: Date | null;
  confidence: number;
  people: EmailEventPerson[];
  asks: string[];
};

/** Why events were dropped. Surfaced in run stats; the only honest way to tune the floor. */
export type ExtractionRejects = {
  badKind: number;
  lowConfidence: number;
  unverifiable: number;
  empty: number;
  suspicious: number;
  duplicate: number;
  capped: number;
};

export type ExtractionResult = { events: ExtractedEvent[]; rejected: ExtractionRejects };
