import {
  Coffee,
  Handshake,
  Mail,
  MessageSquare,
  MessagesSquare,
  NotebookPen,
  PartyPopper,
  Phone,
  Send,
  Users,
  type LucideIcon,
} from "lucide-react";

/**
 * The canonical interaction vocabulary.
 *
 * `interactions.interaction_type` is a bare `text` column with no DB enum, and before this
 * module three different lists disagreed about what could go in it (the timeline offered one
 * set, the capture form another, and writers like `saveNoteBatch` emitted values neither
 * offered). This is the single list every producer and reader now goes through.
 *
 * `tone: "warm"` marks the types that represent time actually spent with a person, as opposed
 * to a message sent or a note filed. The timeline tints those nodes so a year of real meetings
 * reads differently at a glance from a year of LinkedIn messages.
 */
export const INTERACTION_TYPES = [
  { value: "meeting", label: "Meeting", hint: "A scheduled conversation", icon: Users, tone: "warm" },
  { value: "in_person", label: "In person", hint: "Coffee, lunch, dropped by", icon: Coffee, tone: "warm" },
  { value: "event", label: "Event", hint: "Met them at a conference, talk or mixer", icon: PartyPopper, tone: "warm" },
  { value: "intro", label: "Introduction", hint: "They recommended someone, or you were introduced", icon: Handshake, tone: "warm" },
  { value: "call", label: "Call", hint: "Phone or video", icon: Phone, tone: "plain" },
  { value: "email", label: "Email", hint: "An email exchange", icon: Mail, tone: "plain" },
  { value: "message", label: "Message", hint: "Text, DM or chat", icon: MessageSquare, tone: "plain" },
  { value: "linkedin_message", label: "LinkedIn", hint: "A LinkedIn message", icon: MessagesSquare, tone: "plain" },
  { value: "reach_out", label: "Reach out", hint: "You reached out to them", icon: Send, tone: "plain" },
  { value: "note", label: "Note", hint: "Something you wrote down", icon: NotebookPen, tone: "plain" },
] as const satisfies readonly {
  value: string;
  label: string;
  hint: string;
  icon: LucideIcon;
  tone: "warm" | "plain";
}[];

export type InteractionTypeValue = (typeof INTERACTION_TYPES)[number]["value"];
export type InteractionTypeSpec = (typeof INTERACTION_TYPES)[number];

export const DEFAULT_INTERACTION_TYPE: InteractionTypeValue = "note";

/**
 * Values already written to the database by paths that predate this module. They are mapped on
 * read and never written again — existing rows are deliberately left alone rather than migrated,
 * since the column is free text and a rewrite would buy nothing but risk.
 */
const LEGACY_ALIASES: Record<string, InteractionTypeValue> = {
  meeting_note: "meeting",
  outreach: "reach_out",
  coffee: "in_person",
  hangout: "in_person",
  linkedin: "linkedin_message",
  text: "message",
  sms: "message",
};

const BY_VALUE = new Map<string, InteractionTypeSpec>(
  INTERACTION_TYPES.map((t) => [t.value, t])
);

/** Maps any stored `interaction_type` onto the canonical set. Unknown values become "note". */
export function normalizeInteractionType(raw: string | null | undefined): InteractionTypeValue {
  if (!raw) return DEFAULT_INTERACTION_TYPE;
  const key = raw.trim().toLowerCase();
  if (BY_VALUE.has(key)) return key as InteractionTypeValue;
  return LEGACY_ALIASES[key] ?? DEFAULT_INTERACTION_TYPE;
}

export function interactionTypeSpec(raw: string | null | undefined): InteractionTypeSpec {
  return BY_VALUE.get(normalizeInteractionType(raw)) as InteractionTypeSpec;
}

export function interactionTypeLabel(raw: string | null | undefined): string {
  return interactionTypeSpec(raw).label;
}

export function interactionTypeIcon(raw: string | null | undefined): LucideIcon {
  return interactionTypeSpec(raw).icon;
}

/** True for types that represent time spent together rather than a message or a filed note. */
export function isWarmInteractionType(raw: string | null | undefined): boolean {
  return interactionTypeSpec(raw).tone === "warm";
}
