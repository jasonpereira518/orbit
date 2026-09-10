import type { ClosenessTier } from "@/db/schema";

export type SignalKind =
  | "commitment_due"
  | "scheduled_follow_up"
  | "open_loop"
  | "dormant"
  | "thread_quiet"
  | "post_event"
  | "never_contacted"
  | "met_anniversary"
  | "work_anniversary"
  | "birthday"
  | "personal_date"
  | "job_change"
  | "job_opening";

/**
 * What the signal's evidence actually is.
 *
 * "staleness" means the evidence IS the absence of contact, so recent contact refutes
 * it outright. "date" means the evidence is a dated occurrence independent of contact
 * frequency — talking yesterday does not make it less their birthday. The 7-day hard
 * filter in `score.ts` runs entirely off this distinction.
 */
export type SignalTrigger = "date" | "staleness";

export type ContactSnapshot = {
  id: string;
  fullName: string;
  preferredName: string | null;
  title: string | null;
  company: string | null;
  closenessTier: ClosenessTier | null;
  priorityLevel: number;
  relationshipScore: number;
  constellationPin: "in" | "out" | null;
  dateMet: Date | null;
  firstInteractionAt: Date | null;
  lastInteractionAt: Date | null;
  nextFollowUpAt: Date | null;
};

export type InteractionSnapshot = {
  contactId: string;
  interactionType: string;
  interactionDate: Date;
  /** Null for legacy imports that never persisted the sender. Unrecoverable. */
  direction: "in" | "out" | null;
  /** rawNotes, falling back to aiSummary. */
  text: string;
  actionItems: string[];
};

export type ExperienceSnapshot = {
  contactId: string;
  organization: string;
  isCurrent: boolean;
  startYear: number | null;
  startMonth: number | null;
};

export type ContactDateSnapshot = {
  contactId: string;
  kind: string;
  label: string | null;
  month: number;
  day: number;
  year: number | null;
};

export type EventAttendanceSnapshot = {
  contactId: string;
  eventId: string;
  title: string;
  startsAt: Date;
};

export type DueCommitmentSnapshot = {
  contactId: string;
  title: string;
  dueDate: Date;
};

/**
 * Everything every source needs, loaded exactly once per user.
 *
 * Sources are pure functions over this. They do not query — thirteen sources each
 * running their own queries per contact is the query storm this type exists to prevent.
 */
export type SignalContext = {
  userId: string;
  now: Date;
  contacts: ContactSnapshot[];
  /** Newest first. */
  interactionsByContact: Map<string, InteractionSnapshot[]>;
  experiencesByContact: Map<string, ExperienceSnapshot[]>;
  datesByContact: Map<string, ContactDateSnapshot[]>;
  eventsByContact: Map<string, EventAttendanceSnapshot[]>;
  contactsWithPendingReminder: Set<string>;
  dueCommitments: DueCommitmentSnapshot[];
};

export type SignalCandidate = {
  kind: SignalKind;
  contactId: string;
  /** One short human-readable clause explaining what fired. */
  evidence: string;
  /** The calendar day this should surface on. May be in the future. */
  dueOn: Date;
};

export type SignalSource = {
  kind: SignalKind;
  cadence: "daily" | "opt-in";
  detect(ctx: SignalContext): SignalCandidate[];
};
