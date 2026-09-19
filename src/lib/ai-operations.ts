/**
 * Every AI call Orbit makes, by the `operation` id it records in `usage_events`.
 *
 * One registry because three hand-kept lists drifted apart: the settings usage card's
 * labels, the admin adoption screen's `KNOWN_OPERATIONS`, and the managed allowance's
 * background set each missed a different handful of operations (extension.*, meeting.*,
 * chat.understand/rerank, recruiter.*…), so the card showed raw ids and adoption showed
 * live features as never used. Now each list is derived from this one, and `operation` is
 * typed as `AiOperationId` at the AI entry points, so an unregistered id fails `tsc`.
 *
 * Pure and client-importable: no `@/db`, no env, no SDKs.
 */

/**
 * Which model an operation runs on.
 *
 *  - `user`        the model the person picked in Settings
 *  - `fast`        `FAST_MODELS[provider]` — the cheap tier
 *  - `vision`      `VISION_MODELS[provider]` — OCR, where a misread name can't be recovered
 *  - `embed`       the embedding model for the account's embedding backend
 *  - `transcribe`  the transcription chain (Wispr → Whisper → Gemini)
 *
 * Today this RECORDS what each call site does; the routing still lives at the call sites
 * (`speed: "fast"` / `speed: "vision"`). `scripts/smoke-ai-operations.ts` keeps the two in
 * agreement until routing moves here.
 */
export type AiTier = "user" | "fast" | "vision" | "embed" | "transcribe";

type OperationSpec = {
  /** In words a person would use — the settings usage card shows this. */
  label: string;
  tier: AiTier;
  /**
   * Bulk work running on the person's behalf rather than something they are waiting on.
   * On Orbit's managed keys it stops at `MANAGED_AI_BUDGET.backgroundShare` of the month.
   */
  background?: boolean;
};

export const AI_OPERATIONS = {
  "capture.parse": { label: "Capture: reading notes", tier: "user" },
  "capture.parse.identify": { label: "Capture: finding people", tier: "user" },
  "capture.parse.details": { label: "Capture: details per person", tier: "user" },
  "capture.parse.excerpt-retry": { label: "Capture: re-reading a person’s notes", tier: "user" },
  "capture.dates": { label: "Capture: dates and reminders", tier: "user" },
  "capture.transcribe.page": { label: "Capture: reading photos", tier: "vision" },
  "capture.transcribe.audio": { label: "Capture: voice notes", tier: "transcribe" },
  "meeting.transcribe": { label: "Meeting transcription", tier: "transcribe" },
  "meeting.digest": { label: "Meeting summaries", tier: "user" },
  "meeting.digest.map": { label: "Meeting summaries (long, per part)", tier: "user" },
  "meeting.digest.reduce": { label: "Meeting summaries (long, combined)", tier: "user" },
  "chat.answer": { label: "Chat answers", tier: "user" },
  "chat.understand": { label: "Chat: understanding the question", tier: "fast" },
  "chat.rerank": { label: "Chat: ranking results", tier: "fast" },
  "search.embed": { label: "Search indexing", tier: "embed" },
  "search.embed.batch": { label: "Search indexing (bulk)", tier: "embed", background: true },
  "contact.brief": { label: "Contact briefs", tier: "user" },
  "events.why": { label: "Events: why talk to them", tier: "fast" },
  "extension.parse": { label: "Extension: reading profiles", tier: "user" },
  "extension.starters": { label: "Extension: conversation starters", tier: "user" },
  "followup.draft": { label: "Follow-up drafts", tier: "user" },
  "outreach.draft": { label: "Outreach drafts", tier: "user" },
  "outreach.apollo": { label: "Outreach: prospect search", tier: "user" },
  "recruiter.scan": { label: "Recruiter scan", tier: "user", background: true },
  "recruiter.draft": { label: "Recruiter drafts", tier: "user" },
  "import.enrich": { label: "LinkedIn import summaries", tier: "user", background: true },
  "import.linkedin.timeline": {
    label: "LinkedIn timeline events",
    tier: "fast",
    background: true,
  },
} as const satisfies Record<string, OperationSpec>;

export type AiOperationId = keyof typeof AI_OPERATIONS;

/**
 * Ids that only exist in history: rows written before a call site was renamed or given its
 * own id. Labelled so old usage still reads as words, never offered to new code.
 */
const RETIRED_OPERATION_LABELS: Record<string, string> = {
  "capture.transcribe.images": "Capture: reading photos",
  "contact.summary": "Contact briefs",
  completeJson: "Other AI",
  completeMultimodalJson: "Other AI (images)",
};

export const AI_OPERATION_IDS = Object.keys(AI_OPERATIONS) as AiOperationId[];

export function isAiOperationId(value: string): value is AiOperationId {
  return Object.prototype.hasOwnProperty.call(AI_OPERATIONS, value);
}

export function aiOperationLabel(operation: string): string {
  if (isAiOperationId(operation)) return AI_OPERATIONS[operation].label;
  return RETIRED_OPERATION_LABELS[operation] ?? operation;
}

export function aiOperationTier(operation: AiOperationId): AiTier {
  return AI_OPERATIONS[operation].tier;
}

export const BACKGROUND_AI_OPERATIONS: ReadonlySet<string> = new Set(
  AI_OPERATION_IDS.filter((id) => (AI_OPERATIONS[id] as OperationSpec).background === true)
);
