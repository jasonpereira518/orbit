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
 * `family` groups the ten types into the four things a person actually wants to tell apart at a
 * glance — see `INTERACTION_FAMILIES`. It replaces the earlier `tone: "warm" | "plain"` flag,
 * which drew the same line as `family === "together"` but in a second place that could drift.
 */
export const INTERACTION_TYPES = [
  { value: "meeting", label: "1:1 Meeting", hint: "A scheduled one-to-one", icon: Users, family: "together" },
  { value: "in_person", label: "In person", hint: "Coffee, lunch, dropped by", icon: Coffee, family: "together" },
  { value: "event", label: "Event", hint: "Met them at a conference, talk or mixer", icon: PartyPopper, family: "together" },
  { value: "intro", label: "Introduction", hint: "They recommended someone, or you were introduced", icon: Handshake, family: "together" },
  { value: "call", label: "Call", hint: "Phone or video", icon: Phone, family: "live" },
  { value: "email", label: "Email", hint: "An email exchange", icon: Mail, family: "written" },
  { value: "linkedin_message", label: "LinkedIn", hint: "A LinkedIn message", icon: MessagesSquare, family: "written" },
  { value: "reach_out", label: "Cold intro", hint: "You introduced yourself, with no warm introduction", icon: Send, family: "yours" },
  { value: "note", label: "Note", hint: "Something you wrote down", icon: NotebookPen, family: "yours" },
  {
    value: "message",
    label: "Message",
    hint: "Text, DM or chat",
    icon: MessageSquare,
    family: "written",
    retired: true,
  },
] as const satisfies readonly {
  value: string;
  label: string;
  hint: string;
  icon: LucideIcon;
  family: InteractionFamilyValue;
  /**
   * Kept so stored rows still read correctly, but no longer offered when logging.
   *
   * The column is free text and rows written before a type was retired are left alone, as
   * everything else here is. Aliasing "message" onto another type instead would have been a
   * silent rewrite of history — a text exchange is not a note and is not a LinkedIn message,
   * and there is no honest target for it. So it stays readable and stops being writable.
   */
  retired?: true;
}[];

/**
 * The types offered when logging an interaction, in the order they are shown.
 *
 * Every picker reads this; `INTERACTION_TYPES` stays the full vocabulary for anything that has
 * to render a value already in the database.
 */
export const SELECTABLE_INTERACTION_TYPES = INTERACTION_TYPES.filter(
  (t) => !("retired" in t && t.retired)
);

export type InteractionTypeValue = (typeof INTERACTION_TYPES)[number]["value"];
export type InteractionTypeSpec = (typeof INTERACTION_TYPES)[number];

export const DEFAULT_INTERACTION_TYPE: InteractionTypeValue = "note";

export type InteractionFamilyValue = "together" | "live" | "written" | "yours";

/**
 * The four colour families, ordered by how much of the person was actually present.
 *
 * The family answers "was this real time together, or just text?"; the per-type lucide icon still
 * answers "what specifically happened". Colour is never the only code — every surface that tints
 * by family also carries the type label and the type's own icon.
 *
 * `yours` being the near-neutral family is the point of the scheme rather than an omission:
 * coloured nodes are things that happened *with* the person, grey ones are your own bookkeeping,
 * so on a typical profile the colour that does appear means something.
 *
 * The class strings are written out in full because Tailwind extracts class names statically —
 * `bg-interaction-${family}/12` would compile to nothing.
 *
 * The node fills are `color-mix` against `--card` rather than the alpha shorthand. They read
 * identically on a card, but an alpha fill is transparent, and the timeline's spine runs
 * through the centre of every node — with `/12` the line was visible straight through the
 * disc it was supposed to pass behind.
 */
export const INTERACTION_FAMILIES = [
  {
    value: "together",
    label: "Together",
    hint: "Time actually spent with them",
    /** Filled disc: the one distinction that stays legible with no hue at all. */
    node: "border-interaction-together/35 bg-[color-mix(in_oklab,var(--interaction-together)_12%,var(--card))] text-interaction-together",
    nodeSelected: "border-interaction-together/70 bg-[color-mix(in_oklab,var(--interaction-together)_20%,var(--card))] text-interaction-together",
    chip: "border-interaction-together/45 bg-interaction-together/10 text-interaction-together",
    dot: "bg-interaction-together",
    text: "text-interaction-together",
  },
  {
    value: "live",
    label: "Live",
    hint: "Real-time, but across a distance",
    node: "border-interaction-live/30 bg-card text-interaction-live",
    nodeSelected: "border-interaction-live/70 bg-[color-mix(in_oklab,var(--interaction-live)_12%,var(--card))] text-interaction-live",
    chip: "border-interaction-live/45 bg-interaction-live/10 text-interaction-live",
    dot: "bg-interaction-live",
    text: "text-interaction-live",
  },
  {
    value: "written",
    label: "Written",
    hint: "An asynchronous exchange",
    node: "border-interaction-written/30 bg-card text-interaction-written",
    nodeSelected: "border-interaction-written/70 bg-[color-mix(in_oklab,var(--interaction-written)_12%,var(--card))] text-interaction-written",
    chip: "border-interaction-written/45 bg-interaction-written/10 text-interaction-written",
    dot: "bg-interaction-written",
    text: "text-interaction-written",
  },
  {
    value: "yours",
    label: "Yours",
    hint: "Your own record — nothing confirmed happened with them",
    node: "border-interaction-yours/30 bg-card text-interaction-yours",
    nodeSelected: "border-interaction-yours/70 bg-[color-mix(in_oklab,var(--interaction-yours)_12%,var(--card))] text-interaction-yours",
    chip: "border-interaction-yours/45 bg-interaction-yours/10 text-interaction-yours",
    dot: "bg-interaction-yours",
    text: "text-interaction-yours",
  },
] as const satisfies readonly {
  value: InteractionFamilyValue;
  label: string;
  hint: string;
  node: string;
  nodeSelected: string;
  chip: string;
  dot: string;
  text: string;
}[];

export type InteractionFamilySpec = (typeof INTERACTION_FAMILIES)[number];

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

const BY_FAMILY = new Map<string, InteractionFamilySpec>(
  INTERACTION_FAMILIES.map((f) => [f.value, f])
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

export function interactionTypeFamily(
  raw: string | null | undefined
): InteractionFamilyValue {
  return interactionTypeSpec(raw).family;
}

/** The colour/label metadata for whichever family a stored `interaction_type` belongs to. */
export function interactionFamilySpec(
  raw: string | null | undefined
): InteractionFamilySpec {
  return BY_FAMILY.get(interactionTypeFamily(raw)) as InteractionFamilySpec;
}

/** True for types that represent time spent together rather than a message or a filed note. */
export function isWarmInteractionType(raw: string | null | undefined): boolean {
  return interactionTypeFamily(raw) === "together";
}
