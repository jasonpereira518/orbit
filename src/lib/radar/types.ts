/**
 * Radar's vocabulary: the kinds of recommendation, their order, and the shapes stored on a
 * recommendation row.
 *
 * Pure and client-importable. It imports nothing, so the Drizzle schema can type its jsonb
 * columns with it, the scorer can stay free of the database, and the page's client
 * components can render labels without pulling `@/db` into a browser bundle.
 *
 * Spec: docs/superpowers/specs/2026-09-27-radar-recommendation-engine-design.md
 */

/**
 * Every kind of recommendation, most time-bound first. The order is the tiebreak when two
 * kinds score the same for one person: a meeting on Thursday outranks "you have not spoken
 * in a while", because only one of them stops being true on Friday.
 */
export const RECOMMENDATION_KINDS = [
  "prep",
  "heads_up",
  "follow_up",
  "opportunity",
  "reach_out",
  "reconnect",
] as const;
export type RecommendationKind = (typeof RECOMMENDATION_KINDS)[number];

export const KIND_PRIORITY: Record<RecommendationKind, number> = {
  prep: 6,
  heads_up: 5,
  follow_up: 4,
  opportunity: 3,
  reach_out: 2,
  reconnect: 1,
};

/** The chip on a card. Short, because it sits beside a name. */
export const KIND_LABELS: Record<RecommendationKind, string> = {
  prep: "Coming up",
  heads_up: "Heads-up",
  follow_up: "You owe them",
  opportunity: "Opportunity",
  reach_out: "Reach out",
  reconnect: "Reconnect",
};

/** The section a kind is grouped under below "Today". */
export const KIND_SECTION_TITLES: Record<RecommendationKind, string> = {
  prep: "Before you see them",
  heads_up: "Something changed",
  follow_up: "Loops to close",
  opportunity: "Opportunities",
  reach_out: "Waiting on you",
  reconnect: "Drifting",
};

export const RECOMMENDATION_BUCKETS = ["today", "soon", "later"] as const;
export type RecommendationBucket = (typeof RECOMMENDATION_BUCKETS)[number];

/**
 * `pending` and `snoozed` are live: at most one live row per (user, contact, kind), enforced
 * by `recommendations_live_uidx`. The rest are terminal and kept as history.
 */
export type RecommendationStatus = "pending" | "snoozed" | "accepted" | "dismissed" | "expired";

/** One line of "why", with the points that produced it. The UI shows the label only. */
export type RadarReason = { code: string; label: string; points: number };

/** The most specific fact behind a card, shown under the reasons ("Meeting · Thu 3 Oct"). */
export type RadarEvidence = { label: string; at: string | null };

/** The optional AI line, cached against the inputs it was written from. */
export type RadarAiNote = { why: string; opener: string; inputsHash: string; generatedAt: string };

/** What a person did with a recommendation, recorded so the next run respects it. */
export type RadarFeedbackAction = "accepted" | "dismissed" | "snoozed" | "never" | "restored";

export type RadarRunTrigger = "schedule" | "page" | "manual" | "first_visit";
export type RadarRunStatus = "running" | "ok" | "partial" | "failed";

/**
 * A dated fact about one contact that the scorer turns into points. Internal facts only in
 * phase one: every one of these is read from a table Orbit already keeps. Dormancy and a
 * fresh intro are not signals; the scorer derives them from the contact's own dates.
 */
export type RadarSignal =
  | { kind: "upcoming_meeting"; contactId: string; at: Date; title: string | null }
  | { kind: "event_upcoming"; contactId: string; at: Date; title: string }
  | { kind: "post_event"; contactId: string; at: Date; title: string }
  | { kind: "action_item_open"; contactId: string; at: Date; text: string; count: number }
  | { kind: "opportunity_due"; contactId: string; at: Date; label: string }
  | { kind: "brief_next_step"; contactId: string; at: Date | null; text: string }
  | { kind: "inbound_unanswered"; contactId: string; at: Date }
  | { kind: "linkedin_thread_quiet"; contactId: string; at: Date; count: number }
  | { kind: "job_posting"; contactId: string; at: Date; text: string };

export type RadarSignalKind = RadarSignal["kind"];
