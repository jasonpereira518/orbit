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

export const EXTENSION_CONTRACT_VERSION = 2;

/**
 * The oldest contract the server still serves. Extension updates roll out on
 * Chrome's schedule, not ours, so every shape a v1 build sends stays valid:
 * v2 only ever ADDS optional fields, widens enums in responses, and adds
 * routes. Raise this only for a change a v1 build genuinely cannot survive —
 * the panel then shows a hard "update Orbit" state instead of misbehaving.
 */
export const MIN_SUPPORTED_CONTRACT_VERSION = 1;

/**
 * The extension's paid depth. Its core — recognize, save, notes, follow-ups,
 * reminders — is free on every plan; these four are Pro and Lifetime.
 */
export type ExtensionFeature = "starters" | "workHistory" | "company" | "search";

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
  | "feature_locked"
  | "server_error";

export type ExtensionError = {
  code: ExtensionErrorCode;
  message: string;
  retryAfterSeconds?: number;
  /** Present on `duplicate`: the existing contacts that blocked the create. */
  candidates?: MatchCandidate[];
  /** Present on `feature_locked`: which Pro feature, and where to get it. */
  feature?: ExtensionFeature;
  upgradeUrl?: string;
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

export type PageSite = "linkedin" | "x" | "gmail" | "github" | "generic";

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
  /**
   * The person's other profiles, as linked from this page — a GitHub bio's
   * LinkedIn, a personal site's X. Each is an exact-match key the resolver can
   * use whatever site the page is on. Optional: v1 adapters never send it.
   */
  links?: PageLinks;
};

export type PageLinks = {
  linkedin?: string;
  x?: string;
  github?: string;
};

/** A person visible on a list/thread page that the user may want to pick. */
export type PageCandidate = {
  name: string;
  profileUrl?: string;
  subtitle?: string;
  /** Gmail's multi-party threads know addresses, not profiles. */
  email?: string;
};

/** The organization a company/school page is about. */
export type PageOrg = {
  name: string;
  /** linkedin.com/company/<slug> or /school/<slug>. */
  linkedinSlug?: string;
  /** github.com/<org> */
  githubLogin?: string;
};

export type PageText = {
  blob: string;
  truncated: boolean;
  charCount: number;
  /** True when the blob came from the user's selection rather than the page. */
  fromSelection: boolean;
};

export type PageContext = {
  schemaVersion: 1;
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
  /** Present on company and school pages. */
  org?: PageOrg;
  text: PageText;
  /** Extractor diagnostics: "login-wall", "opaque-slug", "no-main", … */
  warnings: string[];
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
  /** "Reached out", not "reach_out". Optional: older servers send only the code. */
  typeLabel?: string;
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
  /**
   * How the user met them, in their own words, and when. Optional because a
   * server older than this field omits it — the panel treats absent as unknown.
   */
  howMet?: string | null;
  dateMet?: string | null;
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

/**
 * `plan`: AI opening lines are Pro, so a free account gets the heuristic ones —
 * as a normal 200, never a 402, so a v1 panel that knows nothing about plans
 * degrades to what it always showed without an AI key.
 */
export type StartersDegradedReason = "no_api_key" | "ai_error" | "no_signal" | "plan";

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

/**
 * What completing a reminder changed, handed back so an Undo can reverse
 * exactly that. `clearedFollowUpAt` is set when the reminder WAS the contact's
 * follow-up: completing it also cleared the contact's follow-up clock, or the
 * panel would go on saying "Follow-up was due 3 weeks ago" about a thing the
 * user had just marked done.
 */
export type ReminderCompletion = {
  reminderId: string;
  previousStatus: string;
  closedActionItemIds: string[];
  contactId: string | null;
  clearedFollowUpAt: string | null;
};

export type ReminderActionRequest =
  | { action: "complete"; reminderId: string }
  | { action: "reopen"; completion: ReminderCompletion };

export type ReminderActionResponse = {
  reminderId: string;
  /** Set on complete: pass it back as `reopen` to undo. */
  completion: ReminderCompletion | null;
  /** On reopen: false when the reminder had moved on and there was nothing honest to undo. */
  restored: boolean;
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
  /**
   * Which search actually ran. "hybrid" is the ranked search (Pro); a Pro
   * request that ran over budget answers "keyword", so the panel never claims
   * a smarter search than it did. Optional: older servers omit it.
   */
  mode?: "keyword" | "hybrid";
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
    /** "Anthropic", not "anthropic". Optional: older servers send only the id. */
    aiProviderLabel?: string;
  };
  stats: {
    contactCount: number;
    dueFollowUpCount: number;
  };
  /** v2. Absent from a v1 server; the panel treats absent as "unknown", not "free". */
  minSupportedContractVersion?: number;
  entitlements?: ExtensionEntitlements;
  links?: {
    app: string;
    pricing: string;
    settings: string;
  };
};

export type ExtensionEntitlements = {
  plan: "free" | "orbit" | "lifetime";
  /** "Free", "Orbit Pro", "Orbit Lifetime" — for display, never for branching. */
  planLabel: string;
  /** null = unlimited. */
  contactLimit: number | null;
  /** null = unlimited. How many more people this account can save. */
  contactsRemaining: number | null;
  features: Record<ExtensionFeature, boolean>;
};

/**
 * `GET /home?tz=<IANA zone>` — what the panel shows beside a page that isn't
 * about anyone: what's due, and who you've touched lately (the quick-note
 * picker's starting list).
 */
export type HomeReminder = {
  id: string;
  title: string;
  dueDate: string | null;
  /** Due before today, in the viewer's zone — the reminders page's own rule. */
  overdue: boolean;
  contact: { id: string; fullName: string; photoUrl: string | null } | null;
};

export type HomeResponse = {
  /** The viewer's today, YYYY-MM-DD, as the server read it. */
  today: string;
  /** Overdue and due today, oldest first, at most 10. */
  dueReminders: HomeReminder[];
  /** All of them, exactly — the list above is capped, this is not. */
  dueReminderTotal: number;
  recentContacts: ContactSearchResult[];
};

/**
 * `POST /resolve-batch` — who on a list page do you already know? One request
 * for the whole list (≤ 10), so a search-results page costs one call, not ten.
 */
export type ResolveBatchRequest = { candidates: PageCandidate[] };
export type ResolveBatchItem = {
  index: number;
  /**
   * `known`: an exact identity (profile URL, handle, email) owned by one contact.
   * `possible`: a name match only — names are not identities, so never "known".
   * `new`: nobody.
   */
  status: "known" | "possible" | "new";
  contact: ContactSearchResult | null;
};
export type ResolveBatchResponse = { items: ResolveBatchItem[] };

/** `POST /company` — who do you know at this organization? */
export type CompanyLookupRequest = { org: PageOrg };
export type CompanyPerson = ContactSearchResult & {
  /** Works there now (by their contact record), or worked there (by history). */
  relation: "current" | "former";
};
export type CompanyLookupResponse = {
  currentTotal: number;
  formerTotal: number;
  /** Empty when `locked`: the counts are free, the names are Pro. */
  people: CompanyPerson[];
  locked: boolean;
};

/** A click on a locked section — recorded (throttled) as demand for the feature. */
export type GateIntentRequest = { feature: ExtensionFeature; site?: string };
export type GateIntentResponse = { recorded: boolean; upgradeUrl: string };
