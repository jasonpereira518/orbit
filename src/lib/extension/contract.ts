/**
 * The wire contract between the Orbit web app and the browser extension.
 *
 * TYPES ONLY. This file must not import anything — not zod, not `@/db`, not
 * `next/*` — because the extension bundle imports it directly via a path alias
 * and every `import type` here erases to nothing at build time. The runtime
 * validation lives in `./contract.schema.ts`, which the server uses and the
 * extension never loads.
 *
 * Bump EXTENSION_CONTRACT_VERSION on any breaking change. `GET /me` returns it
 * so an outdated installed extension can tell the user to update instead of
 * failing in confusing ways.
 */

export const EXTENSION_CONTRACT_VERSION = 1;

/* -------------------------------------------------------------------------- */
/* Envelope                                                                   */
/* -------------------------------------------------------------------------- */

export type ExtensionErrorCode =
  | "unauthorized"
  | "invalid_request"
  | "rate_limited"
  | "not_found"
  | "duplicate"
  | "limit_exceeded"
  | "payload_too_large"
  | "server_error";

export type ExtensionError = {
  code: ExtensionErrorCode;
  message: string;
  retryAfterSeconds?: number;
  /** Present on `duplicate`: the existing contacts that blocked the create. */
  candidates?: MatchCandidate[];
};

export type ExtensionResponse<T> =
  | { ok: true; data: T }
  | { ok: false; error: ExtensionError };

/* -------------------------------------------------------------------------- */
/* Page context — what the injected extractor sends up                        */
/* -------------------------------------------------------------------------- */

export type FieldConfidence = "high" | "medium" | "low";

/**
 * A single extracted value plus where it came from. Provenance travels with the
 * value so the server can decide what to trust without re-implementing the
 * adapter's knowledge: a slug parsed from the URL is authoritative, an og: tag
 * scraped from a logged-out render is not.
 */
export type ExtractedField = {
  value: string;
  /** Extractor-defined origin, e.g. "url", "ld+json", "h1", "og:title". */
  source: string;
  confidence: FieldConfidence;
} | null;

export type PageSite = "linkedin" | "x" | "gmail" | "generic";

/**
 * What kind of thing the page is. Drives which popup state renders, and keeps
 * the extension honest — a post is labelled as a post, never as a profile.
 */
export type PageKind =
  | "person"
  | "thread"
  | "list"
  | "company"
  | "post"
  | "unknown";

export type PageIdentity = {
  name: ExtractedField;
  headline: ExtractedField;
  title: ExtractedField;
  company: ExtractedField;
  location: ExtractedField;
  school: ExtractedField;
  email: ExtractedField;
  /** LinkedIn slug or X handle, already canonicalized by the adapter. */
  handle: ExtractedField;
  profileUrl: ExtractedField;
  photoUrl: ExtractedField;
};

/** A person visible on a list/thread page that the user may want to pick. */
export type PageCandidate = {
  name: string;
  profileUrl?: string;
  subtitle?: string;
};

export type PageText = {
  blob: string;
  truncated: boolean;
  charCount: number;
  /** True when the blob came from the user's selection rather than the page. */
  fromSelection: boolean;
};

/** One role or school as the adapter read it off the page. */
export type PageExperience = {
  kind: "role" | "education";
  organization: string;
  title: string | null;
  fieldOfStudy: string | null;
  location: string | null;
  description: string | null;
  startYear: number | null;
  startMonth: number | null;
  endYear: number | null;
  endMonth: number | null;
  isCurrent: boolean;
};

/**
 * The profile sections, when the adapter was asked to read them. Absent on every capture
 * that is not a deliberate "Capture experience" press, so the ordinary panel open costs
 * nothing extra.
 */
export type PageProfile = {
  headline: string | null;
  about: string | null;
  skills: Array<{ name: string }>;
  certifications: Array<{ name: string; issuer: string | null; year: number | null }>;
  volunteering: Array<{ organization: string; role: string | null; years: string | null }>;
  publications: Array<{ title: string; publisher: string | null; year: number | null }>;
  experiences: PageExperience[];
  /** A section rendered but yielded nothing usable — the server's cue to try the model. */
  parseIncomplete: boolean;
};

export type PageContext = {
  /**
   * 1 = pre-profile adapters. Still sent by every extension a user has not updated, and
   * therefore still valid forever — Chrome decides when they update, not us.
   */
  schemaVersion: 1 | 2;
  site: PageSite;
  /** Bumped by the adapter on selector changes; logged so DOM churn is visible. */
  adapterVersion: string;
  kind: PageKind;
  /** Canonical, tracking-params stripped. */
  url: string;
  /** Raw location.href, for debugging only. */
  sourceUrl: string;
  capturedAt: string;
  identity: PageIdentity;
  candidates?: PageCandidate[];
  text: PageText;
  /** Extractor diagnostics: "login-wall", "opaque-slug", "no-main", … */
  warnings: string[];
  /** Only ever present on schemaVersion 2 captures the user explicitly asked for. */
  profile?: PageProfile;
};

export type ProfileCaptureResponse = {
  saved: boolean;
  /** Set when the page's slug disagrees with the contact's; the panel must confirm. */
  conflict: { pageSlug: string; contactSlug: string; contactName: string } | null;
  /** True when the model was used because the selectors came back empty. */
  usedFallback: boolean;
  /** True when neither selectors nor the model produced anything. */
  degraded: boolean;
  experienceCount: number;
};

/* -------------------------------------------------------------------------- */
/* Resolve                                                                    */
/* -------------------------------------------------------------------------- */

export type MatchStatus = "none" | "confident" | "ambiguous";

export type MatchCandidate = {
  id: string;
  fullName: string;
  company: string | null;
  title: string | null;
  /** Verbatim from DuplicateMatch.reason, e.g. "Same name + company". */
  reason: string;
  confidence: number;
};

export type ClosenessTier = "inner" | "mid" | "outer";

export type SnapshotInteraction = {
  id: string;
  interactionType: string;
  interactionDate: string | null;
  summary: string | null;
};

export type SnapshotReminder = {
  id: string;
  title: string;
  dueDate: string | null;
};

/**
 * The relationship at a glance. Deliberately excludes `notes` in full — it is
 * unbounded and the user's most sensitive field; `notesPreview` is capped.
 */
export type ContactSnapshot = {
  id: string;
  fullName: string;
  preferredName: string | null;
  company: string | null;
  title: string | null;
  location: string | null;
  linkedinUrl: string | null;
  xHandle: string | null;
  photoUrl: string | null;
  relationshipScore: number;
  priorityLevel: number;
  closeness: number;
  closenessTier: ClosenessTier;
  lastInteractionAt: string | null;
  daysSinceLastInteraction: number | null;
  nextFollowUpAt: string | null;
  followUpStatus: string | null;
  isFollowUpOverdue: boolean;
  tags: string[];
  keyFacts: string[];
  sharedInterests: string[];
  opportunities: string[];
  openActionItems: string[];
  aiSummary: string | null;
  notesPreview: string | null;
  recentInteractions: SnapshotInteraction[];
  openReminders: SnapshotReminder[];
};

/** Field values proposed for the create form, derived from the page. */
export type ContactFieldSuggestion = {
  fullName: string | null;
  firstName: string | null;
  lastName: string | null;
  company: string | null;
  title: string | null;
  location: string | null;
  school: string | null;
  email: string | null;
  linkedinUrl: string | null;
  xHandle: string | null;
  website: string | null;
  photoUrl: string | null;
  tagNames: string[];
  howMet: string | null;
};

/**
 * A field where the live page disagrees with the stored record — "now VP Eng at
 * Stripe". The highest-signal thing the extension can surface about someone you
 * already know, so it gets a first-class field rather than being buried in prose.
 */
export type FieldChange = {
  field: "title" | "company" | "location";
  from: string | null;
  to: string;
};

export type ResolveRequest = {
  page: PageContext;
};

export type ResolveResponse = {
  status: MatchStatus;
  contact: ContactSnapshot | null;
  candidates: MatchCandidate[];
  suggested: ContactFieldSuggestion;
  changes: FieldChange[];
  /**
   * Deterministic starters computed with no AI and no extra queries, so the
   * panel paints real content immediately. `POST /starters` may replace them.
   */
  startersSeed: ConversationStarter[];
};

/* -------------------------------------------------------------------------- */
/* Conversation starters                                                      */
/* -------------------------------------------------------------------------- */

export type StarterKind =
  | "opener"
  | "question"
  | "offer"
  | "reconnect"
  | "congrats"
  | "nudge";

export type StarterMode = "cold" | "warm";

export type ConversationStarter = {
  id: string;
  text: string;
  kind: StarterKind;
  /** The specific fact this came from — "Both worked at Stripe." Rendered as a
   *  caption. A starter without a grounded basis is dropped, not shown. */
  basis: string;
  source: "ai" | "heuristic";
};

export type StartersDegradedReason = "no_api_key" | "ai_error" | "no_signal";

export type StartersRequest = {
  contactId?: string | null;
  page: PageContext;
  limit?: number;
  channel?: "linkedin" | "email";
};

export type StartersResponse = {
  mode: StarterMode;
  starters: ConversationStarter[];
  /** True when these are heuristic rather than AI-generated. Not an error —
   *  it is the normal path for a user with no provider key configured. */
  degraded: boolean;
  degradedReason?: StartersDegradedReason;
};

/* -------------------------------------------------------------------------- */
/* Reading the page with a model                                              */
/* -------------------------------------------------------------------------- */

export type ParseDegradedReason = "no_api_key" | "no_text" | "ai_error";

/**
 * Fields a model read out of the page text.
 *
 * Separate from `/resolve` on purpose: resolution is a slug lookup that must
 * stay fast, while this costs a model call. The panel fires them in parallel
 * and the record fills in as each lands.
 */
export type ParsedProfileFields = {
  fullName: string | null;
  title: string | null;
  company: string | null;
  location: string | null;
  school: string | null;
  email: string | null;
  keyFacts: string[];
  sharedInterests: string[];
  /** Field keys the model flagged as uncertain. */
  lowConfidence: string[];
  degraded: boolean;
  degradedReason?: ParseDegradedReason;
};

export type ParseRequest = { page: PageContext };
export type ParseResponse = ParsedProfileFields;

/* -------------------------------------------------------------------------- */
/* Writes                                                                     */
/* -------------------------------------------------------------------------- */

export type FollowUpInput =
  | { at: string | null }
  | { inDays: number };

export type InlineNote = {
  rawNotes: string;
  interactionType?: string;
  interactionDate?: string;
};

export type SaveContactFields = {
  fullName: string;
  firstName?: string;
  lastName?: string;
  company?: string;
  title?: string;
  location?: string;
  school?: string;
  email?: string;
  phone?: string;
  linkedinUrl?: string;
  xHandle?: string;
  website?: string;
  photoUrl?: string;
  relationshipScore?: number;
  metContext?: string;
  howMet?: string;
  dateMet?: string;
  notes?: string;
  /** A manual revision of the person's summary. Overwrites, not appended —
   *  see `saveContactFromExtension`, which also skips the AI regen this save
   *  would otherwise trigger so the edit isn't clobbered seconds later. */
  aiSummary?: string;
  tagNames?: string[];
  keyFacts?: string[];
  sharedInterests?: string[];
};

export type SaveContactRequest = {
  mode: "create" | "merge";
  /** Required when mode is "merge". */
  contactId?: string;
  page: PageContext;
  fields: SaveContactFields;
  note?: InlineNote;
  followUp?: FollowUpInput;
  /** Override the server-side duplicate guard after the user confirms. */
  force?: boolean;
};

export type SaveContactResponse = {
  contact: ContactSnapshot;
  created: boolean;
  /**
   * Neon HTTP has no cross-statement transactions, so a create + note +
   * follow-up is three writes that can partially fail. Anything that did not
   * land is reported here rather than pretended to be atomic.
   */
  warnings: string[];
};

export type LogInteractionRequest = {
  contactId: string;
  rawNotes: string;
  interactionType?: string;
  interactionDate?: string;
  followUp?: FollowUpInput;
};

export type LogInteractionResponse = {
  interaction: { id: string; interactionDate: string | null };
  contact: {
    id: string;
    lastInteractionAt: string | null;
    nextFollowUpAt: string | null;
  };
  warnings: string[];
};

export type FollowUpRequest = {
  contactId: string;
  /** Snooze an existing generated reminder instead of creating a new one. */
  reminderId?: string;
  title?: string;
} & FollowUpInput;

export type FollowUpResponse = {
  contactId: string;
  nextFollowUpAt: string | null;
  reminderId: string | null;
};

/* -------------------------------------------------------------------------- */
/* Search + session                                                           */
/* -------------------------------------------------------------------------- */

export type ContactSearchResult = {
  id: string;
  fullName: string;
  company: string | null;
  title: string | null;
  photoUrl: string | null;
};

export type ContactSearchResponse = {
  results: ContactSearchResult[];
};

export type MeResponse = {
  contractVersion: number;
  user: {
    /** Display name only — never the raw Clerk id, which leaks into logs and
     *  screenshots and is useless to the extension. */
    name: string | null;
    email: string | null;
    imageUrl: string | null;
  };
  capabilities: {
    hasAiKey: boolean;
    hasApolloKey: boolean;
    aiProvider: string;
  };
  stats: {
    contactCount: number;
    dueFollowUpCount: number;
  };
};
