/** DB-free: the AI usage card imports these. */
export type UsageSummaryRow = {
  operation: string;
  label: string;
  calls: number;
  failures: number;
  inputTokens: number;
  outputTokens: number;
  /** Sum of the per-call estimates recorded at write time. */
  costMicros: number;
  /** Successful calls with no estimate (unpriced model, or no token counts reported). */
  unpricedCalls: number;
};

export type UsageSummary = {
  since: string;
  days: number;
  rows: UsageSummaryRow[];
  totalCalls: number;
  totalCostMicros: number;
  unpricedCalls: number;
};

/** The `operation` ids AI call sites record, in words a person would use. */
const LABELS: Record<string, string> = {
  "capture.parse": "Capture: reading notes",
  "capture.parse.identify": "Capture: finding people",
  "capture.parse.details": "Capture: details per person",
  "capture.dates": "Capture: dates and reminders",
  "capture.transcribe.page": "Capture: reading photos",
  "meeting.transcribe": "Meeting transcription",
  "chat.answer": "Chat answers",
  "chat.understand": "Chat: understanding the question",
  "chat.rerank": "Chat: ranking results",
  "search.embed": "Search indexing",
  "search.embed.batch": "Search indexing (bulk)",
  "recruiter.scan": "Recruiter scan",
  "recruiter.draft": "Recruiter drafts",
  "outreach.draft": "Outreach drafts",
  "outreach.apollo": "Outreach: prospect search",
  "import.linkedin.timeline": "LinkedIn timeline events",
  "import.enrich": "LinkedIn import summaries",
  "followup.draft": "Follow-up drafts",
  "events.why": "Events: why talk to them",
  "contact.brief": "Contact briefs",
};

export function usageOperationLabel(operation: string): string {
  return LABELS[operation] ?? operation;
}
