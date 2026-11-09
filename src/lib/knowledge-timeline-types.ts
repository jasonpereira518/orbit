import { normalizeInteractionType } from "@/lib/interaction-types";

/**
 * DB-free types and helpers for the Knowledge page's per-person timeline, so the client
 * component can import them without dragging `@/db` into the browser bundle.
 */

/** The most rows one person's timeline loads. A person with more sees the latest and a note. */
export const KNOWLEDGE_TIMELINE_LIMIT = 200;

/** Characters of text a row carries. The rest is one click away on the contact's own page. */
export const KNOWLEDGE_TIMELINE_TEXT_CHARS = 600;

export type KnowledgeTimelineKind = "message" | "note" | "meeting" | "event";

export type KnowledgeTimelineItem = {
  id: string;
  kind: KnowledgeTimelineKind;
  /** ISO timestamp. */
  date: string;
  /** The stored `interaction_type`, for the label and icon. Null for an event row. */
  type: string | null;
  /** Set for an event row; interactions are labelled by their type instead. */
  title: string | null;
  text: string | null;
  source: string | null;
  /** `'in'` is them, `'out'` is you. Null means unknown, which older imports leave behind. */
  direction: "in" | "out" | null;
};

export type KnowledgeTimeline = {
  items: KnowledgeTimelineItem[];
  /** True when older rows exist beyond {@link KNOWLEDGE_TIMELINE_LIMIT}. */
  truncated: boolean;
};

/**
 * Legacy values (`meeting_note`, `outreach`, `coffee`) bucket with their modern equivalents,
 * through the same normalizer the contact page's labels use, so the two never disagree.
 */
export function timelineKindOf(type: string | null): Exclude<KnowledgeTimelineKind, "event"> {
  const canonical = normalizeInteractionType(type);
  if (canonical === "linkedin_message" || canonical === "message") return "message";
  if (canonical === "meeting" || canonical === "in_person" || canonical === "event") return "meeting";
  return "note";
}
