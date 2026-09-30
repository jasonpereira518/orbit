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
