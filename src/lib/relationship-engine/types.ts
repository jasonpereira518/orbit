import type { ReminderActionKind, ReminderDateBasis, RelationshipOpenThread, RelationshipRunFlag } from "@/db/schema";

/** One message as the engine reads it. `speaker` is "Me", the contact's first name, or "?". */
export type WindowMessage = {
  interactionId: string;
  at: Date;
  direction: "in" | "out" | null;
  speaker: string;
  text: string;
};

/** The slice of a contact's conversation one pass reads. */
export type MessageWindow = {
  contactId: string;
  messages: WindowMessage[];
  /** Exactly what the model sees inside the fence: one `[YYYY-MM-DD Speaker] text` line per message. */
  text: string;
  /** The newest message in the window — the watermark after a successful pass. */
  last: { at: Date; interactionId: string };
  /** Set when older backlog was dropped to respect MAX_CHUNKS. */
  truncatedBefore: Date | null;
  sources: string[];
};

/** An open item shown to the model so it can say it was resolved. */
export type OpenItemForModel = { key: string; text: string };

export type PreviousDigest = {
  summary: string | null;
  whatTheyDo: string | null;
  workingOn: string | null;
  topics: string[];
  openItems: OpenItemForModel[];
};

export type ValidatedDated = {
  text: string;
  owedBy: "me" | "them";
  dueDate: Date;
  rawDatePhrase: string;
  dateBasis: ReminderDateBasis;
  actionKind: ReminderActionKind;
  /** 0–100 */
  confidence: number;
  excerpt: string;
  messageAt: Date;
  interactionId: string;
};

export type ValidatedUndated = {
  text: string;
  owedBy: "me" | "them" | null;
  origin: "explicit" | "implied";
  /** 0–100 */
  confidence: number;
  excerpt: string;
  messageAt: Date;
  interactionId: string;
  withinDays: number | null;
};

export type ValidatedDigest = {
  whatTheyDo: string | null;
  workingOn: string | null;
  summary: string;
  topics: string[];
  facts: string[];
  dated: ValidatedDated[];
  undated: ValidatedUndated[];
  closedKeys: string[];
  jobChange: { company: string; title: string | null; messageAt: Date } | null;
};

export type PlannedReminder = {
  title: string;
  dueDate: Date;
  rawDatePhrase: string | null;
  dateBasis: ReminderDateBasis;
  origin: "explicit" | "implied";
  actionKind: ReminderActionKind;
  confidence: number;
  excerpt: string;
  interactionId: string;
};

export type PlannedActionItem = {
  text: string;
  owedBy: "me" | "them" | null;
  interactionId: string;
  reminder: PlannedReminder | null;
};

export type DigestWritePlan = {
  actionItems: PlannedActionItem[];
  /** The digest's full open-thread list after this pass (existing − closed + new). */
  openThreads: RelationshipOpenThread[];
  newOpenThreads: number;
  flags: RelationshipRunFlag[];
  /** Action items (`ai:<id>` keys, id part only) the conversation says are done. */
  closeActionItemIds: string[];
  facts: string[];
  remindersPlanned: number;
};
