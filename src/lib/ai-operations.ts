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
import type { ThinkingLevel } from "@/lib/ai-request-options";

/**
 * Which model an operation runs on.
 *
 *  - `user`        the model the person picked in Settings
 *  - `fast`        `FAST_MODELS[provider]` — the cheap tier
 *  - `vision`      `VISION_MODELS[provider]` — OCR, where a misread name can't be recovered
 *  - `embed`       the embedding model for the account's embedding backend
 *  - `transcribe`  the transcription chain (Whisper → Gemini)
 *
 * This DRIVES routing: `modelForOperation` in `ai-models.ts` reads the tier, and the AI
 * entry points read that — there is no per-call-site model argument to disagree with it.
 */
export type AiTier = "user" | "fast" | "vision" | "embed" | "transcribe";

type OperationSpec = {
  /** In words a person would use — the settings usage card shows this. */
  label: string;
  tier: AiTier;
  /**
   * How hard a thinking model should think, where the model has a dial (`ai-request-options`).
   * Absent = the provider's default, which for Gemini 3.x is to think at length. Set only
   * where the eval (`scripts/eval-ai.ts`) showed the lower level loses nothing.
   */
  thinking?: ThinkingLevel;
  /**
   * Bulk work running on the person's behalf rather than something they are waiting on.
   * On Orbit's managed keys it stops at `MANAGED_AI_BUDGET.backgroundShare` of the month.
   */
  background?: boolean;
};

/**
 * WHY SO MANY OPERATIONS THINK "minimal".
 *
 * Gemini 3.x thinks by default — 3.5 Flash at "medium" — and a thinking token bills at the
 * output rate, $9 per million on that model, for extraction work whose visible answer is a
 * few hundred tokens. The Sep 19 2026 eval (docs/ai-evals/) measured it: turning thinking
 * down made these tasks CHEAPER AND BETTER, not cheaper and worse. Recruiter classification
 * went from 56% recall to 100%, voice-note name recall from 70% to 100%, capture reminders
 * from 83% to 100%, at a fraction of the cost. Long thinking was talking these tasks out of
 * answers that were in front of them.
 *
 * The meeting digest is deliberately NOT on this list: it is the one task where turning
 * thinking down cost something (action items 100% → 92%), and the eval that would settle it
 * is still owed. It stays on its provider's default until then.
 */
export const AI_OPERATIONS = {
  "capture.parse": { label: "Capture: reading notes", tier: "user", thinking: "minimal" },
  "capture.parse.identify": { label: "Capture: finding people", tier: "user", thinking: "minimal" },
  "capture.parse.details": { label: "Capture: details per person", tier: "user", thinking: "minimal" },
  "capture.parse.excerpt-retry": { label: "Capture: re-reading a person’s notes", tier: "user", thinking: "minimal" },
  "capture.dates": { label: "Capture: dates and reminders", tier: "fast", thinking: "minimal" },
  "capture.transcribe.page": { label: "Capture: reading photos", tier: "vision", thinking: "minimal" },
  "capture.transcribe.audio": { label: "Capture: voice notes", tier: "transcribe", thinking: "minimal" },
  "meeting.transcribe": { label: "Meeting transcription", tier: "transcribe", thinking: "minimal" },
  "meeting.digest": { label: "Meeting summaries", tier: "user" },
  "meeting.digest.map": { label: "Meeting summaries (long, per part)", tier: "user" },
  "meeting.digest.reduce": { label: "Meeting summaries (long, combined)", tier: "user" },
  "chat.answer": { label: "Chat answers", tier: "user" },
  "chat.understand": { label: "Chat: understanding the question", tier: "fast", thinking: "minimal" },
  "chat.rerank": { label: "Chat: ranking results", tier: "fast", thinking: "minimal" },
  "search.embed": { label: "Search indexing", tier: "embed" },
  "search.embed.batch": { label: "Search indexing (bulk)", tier: "embed", background: true },
  "contact.brief": { label: "Contact briefs", tier: "user" },
  "events.why": { label: "Events: why talk to them", tier: "fast", thinking: "minimal" },
  "extension.parse": { label: "Extension: reading profiles", tier: "fast", thinking: "minimal" },
  "extension.starters": { label: "Extension: conversation starters", tier: "user" },
  "followup.draft": { label: "Follow-up drafts", tier: "user" },
  "outreach.draft": { label: "Outreach drafts", tier: "user" },
  "outreach.apollo": { label: "Outreach: prospect search", tier: "user" },
  "recruiter.scan": { label: "Recruiter scan", tier: "fast", thinking: "minimal", background: true },
  "recruiter.draft": { label: "Recruiter drafts", tier: "user" },
  "import.enrich": { label: "LinkedIn import summaries", tier: "fast", thinking: "minimal", background: true },
  "import.linkedin.timeline": {
    label: "LinkedIn timeline events",
    tier: "fast",
    thinking: "minimal",
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

export function aiOperationThinking(operation: string): ThinkingLevel | undefined {
  return isAiOperationId(operation) ? (AI_OPERATIONS[operation] as OperationSpec).thinking : undefined;
}

export const BACKGROUND_AI_OPERATIONS: ReadonlySet<string> = new Set(
  AI_OPERATION_IDS.filter((id) => (AI_OPERATIONS[id] as OperationSpec).background === true)
);
