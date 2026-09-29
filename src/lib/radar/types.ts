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
 * `pending`, `snoozed` and `auto_applied` are live: at most one live row per (user, contact,
 * kind), enforced by `recommendations_live_v2_uidx`. `auto_applied` is a card autopilot acted
 * on (a follow-up scheduled, a draft written) and that still offers Undo. The rest are
 * terminal and kept as history.
 */
export type RecommendationStatus =
  | "pending"
  | "snoozed"
  | "auto_applied"
  | "accepted"
  | "dismissed"
  | "expired";

/** One live card per (contact, kind): the key the run, the store and the rerank all use. */
export function recommendationKey(contactId: string, kind: RecommendationKind): string {
  return `${contactId}:${kind}`;
}

/** The statuses the live unique index covers. Kept beside the type so SQL and TS agree. */
export const LIVE_RECOMMENDATION_STATUSES = ["pending", "snoozed", "auto_applied"] as const;

/**
 * Reasons that describe the person (or what the person already did) rather than a fact
 * about now. Never an "also" line, never learned by the model.
 */
export const CONTEXT_CODES: ReadonlySet<string> = new Set([
  "tier",
  "priority",
  "stated_close",
  "target_company",
  "goal_match",
  "touched_recently",
  "dismissed_recently",
  "already_scheduled",
]);

/** One line of "why", with the points that produced it. The UI shows the label only. */
export type RadarReason = { code: string; label: string; points: number };

/**
 * The most specific fact behind a card, shown under the reasons ("Meeting · Thu 3 Oct").
 * `url` only for a public source (a headline), already through `safeHttpUrl`, and rendered
 * through it again.
 */
export type RadarEvidence = { label: string; at: string | null; url?: string | null };

/** The optional AI line, cached against the inputs it was written from. */
export type RadarAiNote = { why: string; opener: string; inputsHash: string; generatedAt: string };

/**
 * A message written for a card ahead of time, so acting on it is review-and-send. Cached
 * against the same `inputs_hash` as the AI note: a card whose facts have not moved keeps its
 * draft, and nothing is spent writing it again.
 */
export type RadarDraft = {
  body: string;
  channel: "email" | "linkedin" | "sms";
  inputsHash: string;
  generatedAt: string;
};

/**
 * What one account has taught Radar: accept and decline tallies per kind and per reason
 * code, rebuilt from the last 90 days of rows at the end of every run. `a` counts accepts
 * (a conversion counts double), `d` counts dismissals (an ignored card counts half).
 */
export type RadarModelTally = { a: number; d: number };
export type RadarModel = {
  kinds: Partial<Record<RecommendationKind, RadarModelTally>>;
  reasons: Record<string, RadarModelTally>;
  updatedAt: string;
};

/**
 * What autopilot did for one card: the reminder it scheduled and when it is due. Undo
 * reverses exactly this, and only while the reminder is still the one autopilot set.
 */
export type RadarAutopilotAction = { reminderId: string; dueDate: string; at: string };

/** Per-kind autopilot opt-in. Absent or false means off; nothing is ever sent either way. */
export type RadarAutopilot = Partial<Record<RecommendationKind, boolean>>;

/** Where the nightly Apollo re-check left off, and when the current lap began. */
export type RadarApolloCursor = { after: string | null; lapStartedAt: string };

/**
 * Dated facts about a contact that come from outside Orbit's own tables. Stored in
 * `contact_signals`, deduplicated per account, and read by the scorer like any other signal.
 */
export const CONTACT_SIGNAL_KINDS = [
  "job_change",
  "company_news",
  "social_post",
  "linkedin_activity",
] as const;
export type ContactSignalKind = (typeof CONTACT_SIGNAL_KINDS)[number];

/**
 * Sanitized, length-capped text only: every string here came from a third party (a feed, a
 * post, a page the extension read) and is treated as untrusted wherever it is shown or sent
 * to a model. `url` has already been through `safeHttpUrl`.
 */
export type ContactSignalPayload = {
  /** job_change: which field moved, and from what to what. */
  field?: "title" | "company";
  from?: string | null;
  to?: string;
  /** company_news: the headline and the company it matched. */
  title?: string;
  company?: string;
  /** social_post and linkedin_activity: a short excerpt. */
  excerpt?: string;
  network?: "bluesky" | "mastodon" | "linkedin";
  url?: string | null;
  /** Human label for where it came from ("Hacker News", "SEC EDGAR", "Extension"). */
  sourceLabel?: string;
};

/** The global news tables' source kinds (`external_sources.kind`). */
export type ExternalSourceKind = "rss" | "atom" | "hn" | "edgar";

/** What a person did with a recommendation, recorded so the next run respects it. */
export type RadarFeedbackAction = "accepted" | "dismissed" | "snoozed" | "never";

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
  | { kind: "job_posting"; contactId: string; at: Date; text: string }
  /** A headline about the company they work at (`src/lib/radar/signals/news.ts`). */
  | {
      kind: "company_news";
      contactId: string;
      at: Date;
      title: string;
      source: string;
      url: string | null;
      itemId: string;
      company: string;
    }
  /** A post of theirs: public Bluesky or Mastodon, or LinkedIn saved via the extension. */
  | {
      kind: "social_post";
      contactId: string;
      at: Date;
      excerpt: string;
      network: "bluesky" | "mastodon" | "linkedin";
      url: string | null;
    }
  /** A move the work-history check logged (`contact_career_moves`); `text` is its sentence. */
  | { kind: "job_change"; contactId: string; at: Date; move: "joined" | "left" | "title_change"; text: string };

export type RadarSignalKind = RadarSignal["kind"];
