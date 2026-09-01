import {
  pgTable,
  text,
  timestamp,
  integer,
  real,
  boolean,
  jsonb,
  uuid,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { relations, sql } from "drizzle-orm";

/** Orbit ring a contact sits in. Mirrors `ClosenessBreakdown["tier"]` in `@/lib/closeness`. */
export type ClosenessTier = "inner" | "mid" | "outer";

/**
 * A user's raw-closeness distribution, stored so a single contact can be scored without
 * re-reading the whole network.
 *
 * `quantiles` is a 101-point sketch (p0..p100) of the evidenced raw scores rather than the
 * full sorted array the in-memory cohort uses. Percentile lookup interpolates between
 * breakpoints, which costs a little precision at the tails and buys a row that does not
 * grow with the network. Empty when no contact clears the evidence floor.
 */
export type ClosenessCohortSnapshot = {
  n: number;
  evidencedN: number;
  coverage: number;
  relativeWeight: number;
  quantiles: number[];
  /** Mean of the absolute raw scores. Unlike the blended mean it still moves with network health. */
  averageRaw: number;
  /**
   * Network-wide inputs the raw formula needs, carried here so one contact can be scored
   * without re-reading the network to derive them.
   *
   * These are snapshots, so a contact scored between recalibrations is measured against the
   * shape the orbit had at the last one. That is the same staleness the distribution itself
   * carries, and it resolves the same way.
   */
  maxCompany: number;
  maxSchool: number;
  userDomain: string | null;
  mailConnected: boolean;
};

/**
 * Structural mirror of `ClosenessBreakdown` in `@/lib/closeness`.
 *
 * Declared here rather than imported so `schema.ts` keeps no dependency on the lib layer —
 * drizzle-kit loads this file directly and cannot resolve the `@/` alias. A compile-time
 * assertion in `@/lib/closeness-materialize` keeps the two in step.
 */
export type StoredClosenessBreakdown = {
  raw: number;
  strength: number;
  recency: number;
  cadence: number;
  goalRelevance: number;
  evidence: number;
  prior: number;
  evidenced: number;
  knownWeightShare: number;
  closeness: number;
  percentile: number;
  orbitScore: number;
  tier: ClosenessTier;
};

export const userSettings = pgTable("user_settings", {
  id: uuid("id").defaultRandom().primaryKey(),
  userId: text("user_id").notNull().unique(),
  aiProvider: text("ai_provider").default("gemini"),
  geminiApiKeyEncrypted: text("gemini_api_key_encrypted"),
  openaiApiKeyEncrypted: text("openai_api_key_encrypted"),
  anthropicApiKeyEncrypted: text("anthropic_api_key_encrypted"),
  aiModel: text("ai_model").default("gemini-3.5-flash"),
  onboardingCompletedAt: timestamp("onboarding_completed_at", {
    withTimezone: true,
  }),
  onboardingStep: text("onboarding_step"),
  wizardOfferedAt: timestamp("wizard_offered_at", { withTimezone: true }),
  wizardStep: text("wizard_step"),
  wizardCompletedAt: timestamp("wizard_completed_at", { withTimezone: true }),
  theme: text("theme").$type<"light" | "dark" | "system">(),
  ycModeEnabled: boolean("yc_mode_enabled").default(false),
  /**
   * Manual estimate feeding the Unit Economics LTV calculation. Orbit's subscriber count
   * is too small to derive a reliable churn rate from cancellation history, so this is
   * entered by hand like the expense/spend figures elsewhere in YC mode.
   */
  estimatedMonthlyChurnPct: real("estimated_monthly_churn_pct"),
  apolloApiKeyEncrypted: text("apollo_api_key_encrypted"),
  resendApiKeyEncrypted: text("resend_api_key_encrypted"),
  twilioAccountSidEncrypted: text("twilio_account_sid_encrypted"),
  twilioAuthTokenEncrypted: text("twilio_auth_token_encrypted"),
  twilioFromNumber: text("twilio_from_number"),
  desktopNotifiedIds: jsonb("desktop_notified_ids")
    .$type<string[]>()
    .default([]),
  socialLinks: jsonb("social_links")
    .$type<{
      linkedin?: string;
      twitter?: string;
      github?: string;
      website?: string;
    }>()
    .default({}),
  /**
   * The user's own email, mirrored from Clerk via the webhook. Clerk owns identity;
   * this copy exists so background jobs (which have no request context) can reach the
   * user without a Clerk API hop. No unique constraint — two accounts may legitimately
   * transit the same address.
   */
  email: text("email"),
  /**
   * The user's own name and avatar, mirrored from Clerk on the same events as `email`
   * above and for the same reason: the admin console renders from Postgres alone, and a
   * roster that had to ask Clerk for a display name would put a network call — and a new
   * failure mode — on the critical path of a page that currently has neither.
   *
   * `profileImageUrl` stores Clerk's CDN URL, not the bytes. It is public, it needs no
   * auth, and `user.updated` keeps it fresh, so downloading it into Blob storage would buy
   * nothing. Note that `next.config.ts` declares no `images.remotePatterns`, so this must
   * be rendered with a plain `<img>` (see `src/components/ui/avatar.tsx`) — `next/image`
   * would reject the host at runtime.
   *
   * Accounts predating this mirror have nulls until `scripts/backfill-clerk-identity.ts`
   * runs, so every read site needs an email-then-id fallback.
   */
  firstName: text("first_name"),
  lastName: text("last_name"),
  profileImageUrl: text("profile_image_url"),
  /**
   * How this account arrived — captured on FIRST touch of a marketing page and persisted
   * on the first authenticated request. Write-once: a user who lands via a Reddit link,
   * browses for a week and finally signs up after a direct visit was acquired by Reddit,
   * and last-touch would credit the wrong channel every time.
   *
   * `signupAttributedAt` is what distinguishes "arrived directly" (attributed, all fields
   * null) from "predates this mirror" (never attributed). Without it the two are
   * indistinguishable and every channel rollup silently mixes them.
   */
  signupReferrer: text("signup_referrer"),
  signupUtmSource: text("signup_utm_source"),
  signupUtmMedium: text("signup_utm_medium"),
  signupUtmCampaign: text("signup_utm_campaign"),
  signupLandingPath: text("signup_landing_path"),
  signupAttributedAt: timestamp("signup_attributed_at", { withTimezone: true }),
  /**
   * Opaque bearer token for the read-only ICS reminder feed. Stored in plaintext
   * deliberately: the URL must stay re-displayable when the user adds a second device,
   * and `crypto.ts` uses a random IV per call so ciphertext could not be indexed for
   * lookup. Same sensitivity class as `calendar_subscriptions.ics_url`, which already
   * holds the user's Google secret iCal URL in plaintext.
   */
  calendarFeedToken: text("calendar_feed_token"),
  calendarFeedTokenCreatedAt: timestamp("calendar_feed_token_created_at", {
    withTimezone: true,
  }),
  calendarFeedLastFetchedAt: timestamp("calendar_feed_last_fetched_at", {
    withTimezone: true,
  }),
  /**
   * Billing. Entitlements are resolved exclusively from these columns by
   * `src/lib/entitlements.ts` — never by calling Clerk's `has()` or Stripe at a gate.
   * Stripe sells both paid tiers (the Pro subscription and the one-time Lifetime), and
   * its webhook mirrors them here so that background jobs (which have no request
   * context) resolve the same plan the UI does. Same rationale as `email` above.
   */
  compedPlan: text("comped_plan").$type<"orbit" | "lifetime">(),
  lifetimePurchasedAt: timestamp("lifetime_purchased_at", { withTimezone: true }),
  stripeCustomerId: text("stripe_customer_id"),
  subscriptionPlan: text("subscription_plan").$type<"orbit">(),
  subscriptionStatus: text("subscription_status").$type<
    "active" | "past_due" | "canceled"
  >(),
  subscriptionPeriodEnd: timestamp("subscription_period_end", {
    withTimezone: true,
  }),
  /**
   * Provenance for a comped plan. `compedPlan` alone is a fact with no story, and it
   * outranks every real billing signal in `resolvePlan` permanently — so six months later
   * "why is this account on Lifetime?" has to be answerable from the row itself.
   *
   * Deliberately no `compedUntil`: an expiry that no scheduled job enforces is a lie, and
   * enforcing one would mean `resolvePlan` has to consider time for comps, changing a
   * function every gate in the app depends on. `resolvePlan` already takes `now`, so this
   * stays cheap to add later.
   */
  compedNote: text("comped_note"),
  compedAt: timestamp("comped_at", { withTimezone: true }),
  compedBy: text("comped_by"),
  /**
   * The last time this human was present. Two writers, deliberately sharing one column:
   *
   *  - `POST /api/presence`, a ~45s heartbeat from every visible tab (`src/lib/presence.ts`).
   *    This is what makes "active now" answerable at all — a user reading and scrolling one
   *    open tab issues no server requests, so before the heartbeat they read as idle.
   *  - `ensureUserSettings` → `touchLastActive`, throttled to 15 minutes, which covers
   *    non-browser access and any request that arrives with the heartbeat not yet running.
   *
   * Keeping them on one column is what stops "last seen" and "active now" from drifting
   * into two nearly-identical timestamps that every read site has to reconcile. The
   * heartbeat makes the throttled writer almost always short-circuit, so this got *cheaper*
   * to maintain, not more expensive.
   *
   * Distinct from `updatedAt`, which means "settings changed" and is bumped by a dozen
   * unrelated writers — conflating the two would poison `updatedAt` for every future use.
   *
   * Null for every account that predates this column; admin surfaces fall back to a
   * derived last-write timestamp, so the roster is useful without a warm-up period.
   */
  lastActiveAt: timestamp("last_active_at", { withTimezone: true }),
  /**
   * Opt-in to the shared recruiter pool. Integer, not boolean, per house convention.
   *
   * Defaults to 0 for everyone, including accounts that predate it: the `recruiters`
   * table was globally readable before any consent existed, so the only defensible
   * migration is to start the pool empty and let it refill by explicit opt-in.
   *
   * The exchange is reciprocal — 0 means you contribute nothing and see only the
   * recruiters you added yourself. See `isViewerSharing` in `src/lib/recruiters.ts`.
   */
  recruiterSharing: integer("recruiter_sharing").default(0).notNull(),
  /**
   * Operator suspension. Enforced in `requireUserId()` (`src/lib/auth.ts`) rather than in a
   * layout: actions are reachable by direct POST, so the gate has to sit at the one function
   * every page *and* every server action already calls.
   *
   * Deliberately a timestamp rather than a boolean — "when did this happen" is the first
   * question asked about a suspension, and `admin_audit_log` is the only other record.
   */
  suspendedAt: timestamp("suspended_at", { withTimezone: true }),
  suspendedReason: text("suspended_reason"),
  suspendedBy: text("suspended_by"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

export const companies = pgTable(
  "companies",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: text("user_id").notNull(),
    name: text("name").notNull(),
    nameNormalized: text("name_normalized").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index("companies_user_idx").on(t.userId),
    uniqueIndex("companies_user_name_uidx").on(t.userId, t.nameNormalized),
  ]
);

export const contacts = pgTable(
  "contacts",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: text("user_id").notNull(),
    fullName: text("full_name").notNull(),
    firstName: text("first_name"),
    lastName: text("last_name"),
    preferredName: text("preferred_name"),
    company: text("company"),
    companyId: uuid("company_id").references(() => companies.id, {
      onDelete: "set null",
    }),
    title: text("title"),
    location: text("location"),
    school: text("school"),
    email: text("email"),
    phone: text("phone"),
    linkedinUrl: text("linkedin_url"),
    /** Bare X/Twitter handle, no leading "@" — see normalizeXHandle in lib/duplicates. */
    xHandle: text("x_handle"),
    website: text("website"),
    profileImageUrl: text("profile_image_url"),
    relationshipScore: integer("relationship_score").default(2).notNull(),
    /**
     * Closeness the user actually asserted, 1–5. NULL means never rated —
     * which `relationshipScore` cannot express, because its default of 2 is
     * indistinguishable from a deliberate 2. Evidence weighting depends on
     * telling those apart. Kept in sync with `relationshipScore` on write.
     */
    statedCloseness: integer("stated_closeness"),
    priorityLevel: integer("priority_level").default(0).notNull(),
    source: text("source"),
    industry: text("industry"),
    metContext: text("met_context"),
    dateMet: timestamp("date_met", { withTimezone: true }),
    howMet: text("how_met"),
    sharedInterests: jsonb("shared_interests").$type<string[]>().default([]),
    keyFacts: jsonb("key_facts").$type<string[]>().default([]),
    opportunities: jsonb("opportunities").$type<string[]>().default([]),
    firstInteractionAt: timestamp("first_interaction_at", { withTimezone: true }),
    lastInteractionAt: timestamp("last_interaction_at", { withTimezone: true }),
    nextFollowUpAt: timestamp("next_follow_up_at", { withTimezone: true }),
    followUpStatus: text("follow_up_status").default("none"),
    aiSummary: text("ai_summary"),
    notes: text("notes"),

    /**
     * Materialized closeness. These are written by `src/lib/closeness-materialize.ts`, not
     * by any normal contact write, and are always the result of applying the user's stored
     * cohort snapshot to `closenessRaw`.
     *
     * They exist because closeness is cohort-relative: a contact's ring is its position in
     * the distribution formed by the whole network. Computing it on read meant every
     * surface had to load every contact to render any of them, which is what made the
     * contacts page O(network size). Storing the applied result is what lets a page of 50
     * be served without the other 4,950.
     *
     * Nullable on purpose — NULL means "never scored", which is how a contact created
     * before this shipped, or since the last recalibration, asks to be picked up.
     */
    closenessRaw: real("closeness_raw"),
    closeness: integer("closeness"),
    closenessTier: text("closeness_tier").$type<ClosenessTier>(),
    orbitScore: integer("orbit_score"),
    /** Evidence and prior are what `selectTriageCandidates` ranks on. */
    closenessEvidence: real("closeness_evidence"),
    closenessPrior: real("closeness_prior"),
    closenessComputedAt: timestamp("closeness_computed_at", { withTimezone: true }),
    /*
     * `closeness_breakdown jsonb` also exists on this table but is deliberately NOT declared
     * here — see `SCALE_DDL` in `src/db/index.ts`.
     *
     * It holds the full breakdown including component scores, and exactly one query needs
     * it. Declaring it would put it in the default select list of the 27 contact queries
     * that have no explicit projection, several of which scan the whole table, so every
     * import dedupe pass and knowledge-base load would start dragging a few hundred bytes
     * of JSON per contact across the wire to ignore it. Keeping it undeclared makes reading
     * it an explicit act — `readStoredCohortResult` asks for it in raw SQL.
     */

    /**
     * Generated columns. Postgres maintains all three; never write to them.
     *
     * `sortKey` is the keyset-pagination ordering column, and the reason contact paging can
     * be a total order in SQL rather than a `localeCompare` in JavaScript.
     * `linkedinSlug` replaces a leading-wildcard ILIKE across every user's contacts.
     * `searchTsv` is the weighted search vector; see `SCALE_DDL` in `src/db/index.ts` for
     * the weight classes and why the config is 'simple'.
     */
    sortKey: text("sort_key").generatedAlwaysAs(
      sql`lower(coalesce(nullif(trim(last_name), ''), split_part(trim(full_name), ' ', -1)))`
    ),
    linkedinSlug: text("linkedin_slug").generatedAlwaysAs(
      sql`lower(nullif(split_part(split_part(split_part(split_part(coalesce(linkedin_url, ''), '/in/', 2), '?', 1), '#', 1), '/', 1), ''))`
    ),

    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),

    /**
     * Set when a write changed text the contact's embedding is built from.
     *
     * Imports no longer embed inline — they flag rows here and a backfill claims them. NULL
     * means "the stored embedding matches the current content", which is also true of a
     * contact that was never embedded and has no embedding row at all; the backfill treats
     * both the same way.
     */
    embeddingStaleAt: timestamp("embedding_stale_at", { withTimezone: true }),
  },
  (t) => [
    index("contacts_user_id_idx").on(t.userId),
    index("contacts_company_idx").on(t.userId, t.company),
    index("contacts_follow_up_idx").on(t.userId, t.nextFollowUpAt),
    index("contacts_user_sort_idx").on(t.userId, t.sortKey, t.fullName, t.id),
    index("contacts_user_updated_idx").on(t.userId, t.updatedAt),
    index("contacts_user_closeness_idx").on(t.userId, t.closeness.desc(), t.id.desc()),
    index("contacts_user_recent_idx").on(t.userId, t.updatedAt.desc(), t.id.desc()),
    index("contacts_company_id_idx").on(t.companyId),
    // The browser extension resolves a profile to a contact on every panel open;
    // without these, each lookup is a full per-user scan.
    index("contacts_user_linkedin_idx").on(t.userId, t.linkedinUrl),
    index("contacts_user_x_idx").on(t.userId, t.xHandle),
  ]
);

/**
 * The per-user closeness distribution that `contacts.closeness*` was applied against.
 *
 * `snapshot` holds a fixed-size quantile sketch rather than the full sorted score array, so
 * this row stays the same size whether the user has 50 contacts or 50,000. `dirtyAt` is set
 * by writes that invalidate the distribution and cleared by recalibration.
 */
export const closenessCohorts = pgTable("closeness_cohorts", {
  userId: text("user_id").primaryKey(),
  snapshot: jsonb("snapshot").$type<ClosenessCohortSnapshot>().default({} as ClosenessCohortSnapshot).notNull(),
  contactCount: integer("contact_count").default(0).notNull(),
  computedAt: timestamp("computed_at", { withTimezone: true }).defaultNow().notNull(),
  dirtyAt: timestamp("dirty_at", { withTimezone: true }),
});

export const userGoals = pgTable(
  "user_goals",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: text("user_id").notNull(),
    text: text("text").notNull(),
    active: integer("active").default(1).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index("user_goals_user_idx").on(t.userId)]
);

export const tags = pgTable(
  "tags",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: text("user_id").notNull(),
    name: text("name").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index("tags_user_id_idx").on(t.userId)]
);

export const contactTags = pgTable(
  "contact_tags",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    contactId: uuid("contact_id")
      .notNull()
      .references(() => contacts.id, { onDelete: "cascade" }),
    tagId: uuid("tag_id")
      .notNull()
      .references(() => tags.id, { onDelete: "cascade" }),
  },
  (t) => [index("contact_tags_contact_idx").on(t.contactId)]
);

export const interactions = pgTable(
  "interactions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: text("user_id").notNull(),
    contactId: uuid("contact_id")
      .notNull()
      .references(() => contacts.id, { onDelete: "cascade" }),
    interactionType: text("interaction_type").default("note").notNull(),
    interactionDate: timestamp("interaction_date", { withTimezone: true })
      .defaultNow()
      .notNull(),
    /** Manual order among interactions on the same calendar day (lower = earlier in list when date desc). */
    sameDayOrder: integer("same_day_order").default(0).notNull(),
    source: text("source"),
    externalId: text("external_id"),
    rawNotes: text("raw_notes"),
    aiSummary: text("ai_summary"),
    topics: jsonb("topics").$type<string[]>().default([]),
    actionItems: jsonb("action_items").$type<string[]>().default([]),
    sentiment: text("sentiment"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index("interactions_contact_idx").on(t.contactId),
    index("interactions_user_idx").on(t.userId),
    index("interactions_user_type_idx").on(t.userId, t.interactionType),
    index("interactions_user_contact_type_date_idx").on(
      t.userId,
      t.contactId,
      t.interactionType,
      t.interactionDate
    ),
    // Soft unique for import dedupe; NULLs allowed (manual notes have no externalId).
    uniqueIndex("interactions_user_external_uidx").on(t.userId, t.externalId),
  ]
);

export type ReminderActionKind =
  | "call"
  | "email"
  | "meet"
  | "task"
  | "follow_up";

export const reminderLists = pgTable(
  "reminder_lists",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: text("user_id").notNull(),
    name: text("name").notNull(),
    nameNormalized: text("name_normalized").notNull(),
    position: integer("position").default(0).notNull(),
    isInbox: integer("is_inbox").default(0).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index("reminder_lists_user_idx").on(t.userId),
    uniqueIndex("reminder_lists_user_name_uidx").on(t.userId, t.nameNormalized),
  ]
);

export const reminders = pgTable(
  "reminders",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: text("user_id").notNull(),
    contactId: uuid("contact_id").references(() => contacts.id, {
      onDelete: "cascade",
    }),
    listId: uuid("list_id").references(() => reminderLists.id, {
      onDelete: "set null",
    }),
    title: text("title").notNull(),
    description: text("description"),
    dueDate: timestamp("due_date", { withTimezone: true }),
    status: text("status").default("pending").notNull(),
    reminderType: text("reminder_type").default("manual").notNull(),
    actionKind: text("action_kind")
      .$type<ReminderActionKind>()
      .default("task")
      .notNull(),
    createdBy: text("created_by").default("user").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index("reminders_user_status_idx").on(t.userId, t.status),
    index("reminders_due_idx").on(t.userId, t.dueDate),
    index("reminders_list_idx").on(t.userId, t.listId),
  ]
);

/**
 * Dated commitments the AI pulled out of captured notes, staged for review.
 *
 * These are deliberately NOT rows in `reminders`: an unconfirmed extraction must never
 * reach `listDueNotificationItems`, which fires OS desktop notifications. Confirming a
 * row here inserts into `reminders` and back-links via `reminderId`.
 */
export const suggestedReminders = pgTable(
  "suggested_reminders",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: text("user_id").notNull(),
    /** Set null rather than cascade — a deleted contact shouldn't silently drop the item. */
    contactId: uuid("contact_id").references(() => contacts.id, {
      onDelete: "set null",
    }),
    /** Groups everything extracted from one capture submission. */
    captureBatchId: uuid("capture_batch_id").notNull(),
    title: text("title").notNull(),
    description: text("description"),
    /** The date text verbatim as written in the note, e.g. "Sept 2". */
    rawDatePhrase: text("raw_date_phrase").notNull(),
    /** Resolved absolute date, pinned to local noon. Never null — absolute dates only. */
    dueDate: timestamp("due_date", { withTimezone: true }).notNull(),
    /** 1 when the note stated no year and we inferred the nearest future one. */
    yearInferred: integer("year_inferred").default(0).notNull(),
    /** The sentence the commitment came from — this is what makes it auditable. */
    sourceExcerpt: text("source_excerpt").notNull(),
    /** sha256 of the normalized source note, so a re-paste is recognized. */
    sourceHash: text("source_hash").notNull(),
    /** sha256(sourceHash|isoDate|normalizedTitle) — the per-item dedupe key. */
    itemHash: text("item_hash").notNull(),
    actionKind: text("action_kind")
      .$type<ReminderActionKind>()
      .default("task")
      .notNull(),
    /** 0-100, matching aiSuggestions.confidenceScore's scale. */
    confidenceScore: integer("confidence_score"),
    /** pending | confirmed | discarded */
    status: text("status").default("pending").notNull(),
    reminderId: uuid("reminder_id").references(() => reminders.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
  },
  (t) => [
    index("suggested_reminders_user_status_idx").on(t.userId, t.status),
    index("suggested_reminders_batch_idx").on(t.captureBatchId),
    uniqueIndex("suggested_reminders_user_item_uidx").on(t.userId, t.itemHash),
  ]
);

export type ImportStats = {
  skipped?: number;
  /**
   * Rows that parsed fine but could not be saved because the user's plan contact limit
   * was already full. Distinct from `skipped` (malformed/unusable rows) so the UI can
   * offer an upgrade rather than an error.
   */
  blockedByPlan?: number;
  messagesImported?: number;
  meetingsLogged?: number;
  remindersCreated?: number;
  /**
   * Interactions the engine's bulk insert actually wrote this run (see
   * `ImportAdapter.interactions` in `import-engine.ts`) — every adapter that produces
   * interaction rows shares this one counter rather than each getting its own per-type field
   * the way `messagesImported`/`meetingsLogged` used to (and, once an import type moved onto
   * the engine, silently stopped being written — see those two fields' history). Counts rows
   * the insert's `ON CONFLICT DO UPDATE ... RETURNING` touched, which includes both brand-new
   * interactions and existing ones refreshed by a re-upload — see that insert's own comment
   * for why "touched this run," not "brand-new only," is the honest thing to count once the
   * insert stopped being a plain `DO NOTHING`.
   */
  interactionsLogged?: number;
  /**
   * Rows the engine isolated as unwritable and marked `import_job_rows.status = 'failed'`
   * (see `writeWithNarrowing`/`onBadRow` in `import-engine.ts`). Distinct from both
   * `skipped` (rows that parsed but had nothing to attach to) and `blockedByPlan` (rows
   * refused by the contact cap): these are rows the database itself rejected, and
   * isolating them is the whole point of chunk narrowing.
   *
   * Without this counter the isolation is invisible — a job that dropped 20 poison rows
   * reports "completed, 480 created" and never mentions the 20, which is worse than the
   * pre-narrowing behavior of failing loudly.
   */
  failedRows?: number;
  contactsEnriched?: number;
  eventsProcessed?: number;
  /** Contact ids touched during a multi-chunk messages import. */
  touchedContactIds?: string[];

  // --- Gmail recruiter scan ---
  /** Set once the mailbox sweep has enumerated every candidate sender. */
  discoveryComplete?: boolean;
  /**
   * Gmail pagination cursor, persisted every page so a time-boxed exit resumes where it
   * stopped instead of re-walking the mailbox from the start.
   */
  gmailPageToken?: string | null;
  /** Messages examined during discovery — the denominator users actually feel. */
  messagesScanned?: number;
  /** Senders that survived the heuristic prefilter and became work rows. */
  candidateSenders?: number;
  /** Senders the classifier confirmed and wrote to the recruiter tables. */
  recruitersFound?: number;
  /** Senders the classifier rejected or scored below the confidence floor. */
  sendersRejected?: number;

  /** Wall-clock milliseconds across every invocation of this job. */
  durationMs?: number;
  /** SQL statements issued across every invocation. The cost this work exists to bound. */
  statements?: number;
};

export const imports = pgTable("imports", {
  id: uuid("id").defaultRandom().primaryKey(),
  userId: text("user_id").notNull(),
  importType: text("import_type").notNull(),
  fileName: text("file_name"),
  status: text("status").default("pending").notNull(),
  totalRows: integer("total_rows"),
  rowsProcessed: integer("rows_processed").default(0),
  contactsCreated: integer("contacts_created").default(0),
  contactsUpdated: integer("contacts_updated").default(0),
  duplicatesFound: integer("duplicates_found").default(0),
  errorMessage: text("error_message"),
  stats: jsonb("stats").$type<ImportStats>().default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

/** One row of a LinkedIn connections CSV. Rows written before the payload became a
 *  union carry no `kind`, so it stays optional and absence means LinkedIn. */
export type LinkedInImportRowPayload = {
  kind?: "linkedin_connection";
  index: number;
  firstName: string;
  lastName: string;
  url?: string;
  email?: string;
  company?: string;
  position?: string;
  connectedOn?: string;
};

/**
 * One candidate sender from a Gmail recruiter scan — the unit of work is the *sender*,
 * not the message, because classification and summarization both need the whole
 * conversation with a person to say anything useful.
 */
export type GmailSenderRowPayload = {
  kind: "gmail_sender";
  email: string;
  name: string;
  firm: string | null;
  /** Capped at scan time; the classifier only reads the most recent few. */
  messageIds: string[];
};

/** One row of a Google People API contacts fetch, snapshotted for the engine to process. */
export type GoogleContactRowPayload = {
  kind: "google_contact";
  resourceName: string;
  fullName: string;
  firstName: string;
  lastName: string;
  company: string;
  title: string;
  email: string;
  phone: string;
  photoUrl: string;
};

/** One row of an Outlook/Microsoft Graph contacts fetch, snapshotted for the engine to
 *  process. No `photoUrl` — unlike Google People, the Graph contacts endpoint this import
 *  reads from doesn't carry a photo URL alongside the contact fields. */
export type OutlookContactRowPayload = {
  kind: "outlook_contact";
  id: string;
  fullName: string;
  firstName: string;
  lastName: string;
  company: string;
  title: string;
  email: string;
  phone: string;
};

/**
 * One resolved conversation from a LinkedIn Messages export, snapshotted once at parse
 * time so the engine never re-parses the CSV or re-fetches contacts per conversation.
 * `messages[].id` is a hash of (conversationId, date, content) computed at parse time —
 * see `linkedInMessageExternalId` in `src/actions/imports.ts` — and is carried straight
 * through to `interactions.externalId`, which is the entire dedupe mechanism for a
 * re-imported CSV: `linkedinUrl: ""` marks a conversation with no resolvable LinkedIn
 * profile, which the adapter's `identity()` turns into a skipped row.
 */
export type LinkedInMessageThreadRowPayload = {
  kind: "linkedin_message_thread";
  conversationId: string;
  fullName: string;
  firstName: string;
  lastName: string;
  linkedinUrl: string;
  /**
   * `sentAt` is `null` — never a sentinel date — when the CSV's timestamp column could not
   * be parsed. It used to be written as `new Date(0).toISOString()`, which reads downstream
   * as a perfectly valid 1970-01-01: `messageDateRange` accepted it, so one unparseable
   * message pinned the contact's `first_interaction_at` to the epoch, and because
   * `bulkMergeContactsForUser` widens that column with `LEAST`, no later import could ever
   * pull it back. `null` is excluded from the range instead, which is what "we don't know
   * when this was sent" actually means.
   */
  messages: { id: string; body: string; sentAt: string | null }[];
};

/**
 * One (calendar event, attendee) pair — the unit of work for a calendar import.
 *
 * Calendar ingest never creates contacts (`createsContacts: false` on the adapter): it only
 * annotates people already in the network, matching each attendee against the duplicate
 * index and logging a meeting where one matches. The adapter seam takes one identity per row
 * (`identity(payload): DuplicateProbe | null`), and a calendar event has N attendees — rather
 * than widen the seam to `identities(): DuplicateProbe[]` for this one consumer,
 * `confirmCalendarImport` explodes each windowed event into one job row per (event, attendee)
 * pair, organizer included. Progress therefore counts pairs, not events: a 100-event file
 * with 3 attendees each is 300 rows.
 *
 * `eventUid` plus the contact id the engine resolves is what keys `interactions.externalId`
 * (see `calendarMeetingExternalId` in `src/lib/import-adapters/calendar.ts`) — that pair, not
 * `eventUid` alone, is what keeps N attendees of the same event from colliding on the
 * `(user_id, external_id)` unique index.
 */
export type CalendarEventRowPayload = {
  kind: "calendar_event";
  eventUid: string;
  summary: string;
  description: string;
  location: string;
  start: string | null;
  end: string | null;
  attendeeName: string;
  attendeeEmail: string;
  /** Snapshotted once at ingest (from the confirm call's own option) so the per-row adapter
   *  functions don't need any job-level state beyond the payload. */
  createFollowUps: boolean;
};

export type ImportJobRowPayload =
  | LinkedInImportRowPayload
  | GmailSenderRowPayload
  | GoogleContactRowPayload
  | OutlookContactRowPayload
  | LinkedInMessageThreadRowPayload
  | CalendarEventRowPayload;

export function isGmailSenderRow(
  payload: ImportJobRowPayload
): payload is GmailSenderRowPayload {
  return payload.kind === "gmail_sender";
}

export const importJobRows = pgTable(
  "import_job_rows",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    importId: uuid("import_id")
      .notNull()
      .references(() => imports.id, { onDelete: "cascade" }),
    userId: text("user_id").notNull(),
    rowIndex: integer("row_index").notNull(),
    payload: jsonb("payload").$type<ImportJobRowPayload>().notNull(),
    status: text("status").default("pending").notNull(),
    contactId: uuid("contact_id"),
    errorMessage: text("error_message"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index("import_job_rows_import_status_idx").on(t.importId, t.status),
  ]
);

export const calendarSubscriptions = pgTable(
  "calendar_subscriptions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: text("user_id").notNull(),
    label: text("label").default("Calendar"),
    icsUrl: text("ics_url").notNull(),
    selfEmail: text("self_email"),
    enabled: integer("enabled").default(1).notNull(),
    lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }),
    lastSyncStatus: text("last_sync_status"),
    lastSyncError: text("last_sync_error"),
    lastSyncStats: jsonb("last_sync_stats").$type<{
      scanned?: number;
      matched?: number;
      created?: number;
      updated?: number;
      contactsCreated?: number;
      skipped?: number;
    }>(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index("calendar_subscriptions_user_idx").on(t.userId)]
);

export const aiSuggestions = pgTable(
  "ai_suggestions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: text("user_id").notNull(),
    suggestionType: text("suggestion_type").notNull(),
    title: text("title").notNull(),
    description: text("description"),
    relatedContactIds: jsonb("related_contact_ids").$type<string[]>().default([]),
    confidenceScore: integer("confidence_score"),
    status: text("status").default("pending").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index("ai_suggestions_user_idx").on(t.userId, t.status)]
);

export type AudienceFilters = {
  titles?: string[];
  locations?: string[];
  industries?: string[];
  keywords?: string;
  seniorities?: string[];
  organizationNames?: string[];
  organizationDomains?: string[];
};

export type OutreachSequenceStep = {
  delayDays: number;
  intent?: string;
};

export const outreachCampaigns = pgTable(
  "outreach_campaigns",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: text("user_id").notNull(),
    name: text("name").notNull(),
    status: text("status").default("draft").notNull(),
    audienceQuery: text("audience_query"),
    audienceFilters: jsonb("audience_filters").$type<AudienceFilters>().default({}),
    messageIntent: text("message_intent"),
    replyCta: text("reply_cta"),
    tone: text("tone").default("professional"),
    defaultChannel: text("default_channel").default("email"),
    sequenceSteps: jsonb("sequence_steps")
      .$type<OutreachSequenceStep[]>()
      .default([]),
    lastSearchSource: text("last_search_source"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index("outreach_campaigns_user_idx").on(t.userId, t.status)]
);

export const outreachProspects = pgTable(
  "outreach_prospects",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    campaignId: uuid("campaign_id")
      .notNull()
      .references(() => outreachCampaigns.id, { onDelete: "cascade" }),
    externalId: text("external_id").notNull(),
    contactId: uuid("contact_id").references(() => contacts.id, {
      onDelete: "set null",
    }),
    fullName: text("full_name").notNull(),
    title: text("title"),
    company: text("company"),
    email: text("email"),
    phone: text("phone"),
    linkedinUrl: text("linkedin_url"),
    location: text("location"),
    enrichment: jsonb("enrichment").$type<Record<string, unknown>>().default({}),
    status: text("status").default("suggested").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index("outreach_prospects_campaign_idx").on(t.campaignId),
    uniqueIndex("outreach_prospects_campaign_external_uidx").on(
      t.campaignId,
      t.externalId
    ),
  ]
);

export const outreachMessages = pgTable(
  "outreach_messages",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    prospectId: uuid("prospect_id")
      .notNull()
      .references(() => outreachProspects.id, { onDelete: "cascade" }),
    channel: text("channel").notNull(),
    subject: text("subject"),
    body: text("body").notNull().default(""),
    status: text("status").default("draft").notNull(),
    stepIndex: integer("step_index").default(0).notNull(),
    parentMessageId: uuid("parent_message_id"),
    scheduledFor: timestamp("scheduled_for", { withTimezone: true }),
    outcome: text("outcome"),
    outcomeNotes: text("outcome_notes"),
    repliedAt: timestamp("replied_at", { withTimezone: true }),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    lastActionAt: timestamp("last_action_at", { withTimezone: true }),
    errorMessage: text("error_message"),
    deliveryId: text("delivery_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index("outreach_messages_prospect_idx").on(t.prospectId),
    index("outreach_messages_status_idx").on(t.status),
    index("outreach_messages_outcome_idx").on(t.outcome),
    index("outreach_messages_scheduled_idx").on(t.scheduledFor),
  ]
);

export const contactEmbeddings = pgTable(
  "contact_embeddings",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: text("user_id").notNull(),
    contactId: uuid("contact_id")
      .notNull()
      .references(() => contacts.id, { onDelete: "cascade" }),
    sourceType: text("source_type").notNull(),
    sourceId: text("source_id"),
    embedding: jsonb("embedding").$type<number[]>().notNull(),
    content: text("content").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index("embeddings_user_idx").on(t.userId),
    index("embeddings_contact_idx").on(t.contactId),
    /**
     * Mirrors the hand-written `CREATE UNIQUE INDEX` in `src/db/index.ts` (both the PGlite
     * migration body and the Neon `alters` list) and in
     * `scripts/migrate-embedding-stale.ts`. All four must agree on name AND column list.
     *
     * Nothing at runtime reads this declaration — Orbit's migrations are hand-written SQL,
     * deliberately, because `drizzle-kit push` drops the runtime-managed
     * `embedding_vector` column. But `drizzle.config.ts` points `schema` at this file and
     * `package.json` still ships `db:push`/`db:generate`, so a stale declaration here is a
     * loaded gun: running either would recreate whatever this says against whatever
     * `DATABASE_URL` resolves to.
     *
     * `source_id` is in the key because that is the real uniqueness contract.
     * `upsertContactEmbedding` (`src/lib/search.ts`) keys its existence check on all four
     * columns, and `calendar-sync.ts` writes one `"meeting"` row per meeting with a
     * distinct `source_id`. Dropping it makes the migration's dedupe delete every meeting
     * embedding but the newest per contact, and makes each later meeting write raise a
     * unique violation that `upsertContactEmbedding`'s blanket `catch {}` swallows.
     * `source_id` is nullable and Postgres indexes NULLs as distinct, so rows written
     * without one stay unconstrained — matching the writer, which skips its existence
     * check when no `source_id` is supplied.
     */
    uniqueIndex("embeddings_user_contact_source_id_uidx").on(
      t.userId,
      t.contactId,
      t.sourceType,
      t.sourceId
    ),
  ]
);

export type RecruiterLinkStatus =
  | "planned"
  | "contacted"
  | "active"
  | "archived";

export type RecruiterLinkSource = "manual" | "gmail" | "chat";

/** Crowdsourced canonical recruiter profile (global, not user-scoped). */
export const recruiters = pgTable(
  "recruiters",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    fullName: text("full_name").notNull(),
    nameNormalized: text("name_normalized").notNull(),
    firm: text("firm"),
    firmNormalized: text("firm_normalized"),
    specialty: jsonb("specialty").$type<string[]>().default([]),
    email: text("email"),
    emailNormalized: text("email_normalized"),
    linkedinUrl: text("linkedin_url"),
    phone: text("phone"),
    avgRating: integer("avg_rating").default(0).notNull(),
    ratingCount: integer("rating_count").default(0).notNull(),
    logCount: integer("log_count").default(0).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index("recruiters_name_idx").on(t.nameNormalized),
    index("recruiters_firm_idx").on(t.firmNormalized),
    index("recruiters_email_idx").on(t.emailNormalized),
    index("recruiters_rating_idx").on(t.avgRating, t.logCount),
  ]
);

/** Personal relationship to a shared recruiter — unlocks PII for this user. */
export const userRecruiterLinks = pgTable(
  "user_recruiter_links",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: text("user_id").notNull(),
    recruiterId: uuid("recruiter_id")
      .notNull()
      .references(() => recruiters.id, { onDelete: "cascade" }),
    status: text("status")
      .$type<RecruiterLinkStatus>()
      .default("planned")
      .notNull(),
    personalRating: integer("personal_rating"),
    notes: text("notes"),
    source: text("source")
      .$type<RecruiterLinkSource>()
      .default("manual")
      .notNull(),
    contactId: uuid("contact_id").references(() => contacts.id, {
      onDelete: "set null",
    }),
    /**
     * Per-recruiter exception to the global `user_settings.recruiter_sharing` opt-in.
     * Only consulted when the global toggle is on, so the default of 1 is inert until
     * the user opts in — it can never widen visibility on its own.
     */
    sharedToPool: integer("shared_to_pool").default(1).notNull(),
    /**
     * Private-to-the-owner summary of this relationship, written by the Gmail scan.
     * Deliberately on the link and never on `recruiters`: the canonical row is shared,
     * and a summary distilled from someone's inbox carries salary talk, rejections, and
     * other detail that must never reach the pool. `toPublicRecruiter` never emits it.
     */
    aiSummary: text("ai_summary"),
    companiesMentioned: jsonb("companies_mentioned").$type<string[]>().default([]),
    rolesDiscussed: jsonb("roles_discussed").$type<string[]>().default([]),
    firstEmailAt: timestamp("first_email_at", { withTimezone: true }),
    lastEmailAt: timestamp("last_email_at", { withTimezone: true }),
    emailCount: integer("email_count").default(0).notNull(),
    /** Most recent Gmail thread with this recruiter, so replies thread correctly. */
    gmailThreadId: text("gmail_thread_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index("user_recruiter_links_user_idx").on(t.userId),
    index("user_recruiter_links_recruiter_idx").on(t.recruiterId),
    uniqueIndex("user_recruiter_links_user_recruiter_uidx").on(
      t.userId,
      t.recruiterId
    ),
  ]
);

export type RecruiterMessageIntent =
  | "set_up_chat"
  | "route_to_person"
  | "upcoming_drops"
  | "interview_resources";

export type RecruiterMessageStatus = "draft" | "queued" | "sent" | "failed";

/**
 * An outbound email to a recruiter, drafted by the LLM and sent through the user's own
 * Gmail. Rows persist after sending: they are the send-rate ledger the daily cap counts,
 * and the record of what was actually said.
 */
export const recruiterMessages = pgTable(
  "recruiter_messages",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: text("user_id").notNull(),
    recruiterId: uuid("recruiter_id")
      .notNull()
      .references(() => recruiters.id, { onDelete: "cascade" }),
    intent: text("intent").$type<RecruiterMessageIntent>().notNull(),
    subject: text("subject").notNull(),
    body: text("body").notNull(),
    status: text("status")
      .$type<RecruiterMessageStatus>()
      .default("draft")
      .notNull(),
    gmailMessageId: text("gmail_message_id"),
    gmailThreadId: text("gmail_thread_id"),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    errorMessage: text("error_message"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index("recruiter_messages_user_idx").on(t.userId, t.status),
    index("recruiter_messages_recruiter_idx").on(t.recruiterId),
    // Backs the daily send cap, which counts this user's sends since midnight.
    index("recruiter_messages_sent_idx").on(t.userId, t.sentAt),
  ]
);

export const gmailConnections = pgTable(
  "gmail_connections",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: text("user_id").notNull().unique(),
    emailAddress: text("email_address").notNull(),
    accessTokenEncrypted: text("access_token_encrypted").notNull(),
    refreshTokenEncrypted: text("refresh_token_encrypted"),
    tokenExpiresAt: timestamp("token_expires_at", { withTimezone: true }),
    scopes: text("scopes"),
    /**
     * Exactly two values. NOT "expired"/"revoked": disconnecting deletes the row, so a
     * third value nothing ever writes would recreate the bug this replaced — the column
     * was previously written only as "active", making every health check on it dead code.
     *
     * `needs_reauth` is written only on a token-level rejection (no refresh token, or the
     * provider returning invalid_grant), never on a transport failure — a provider outage
     * must not flag every account. Cleared by re-running OAuth, which is the only way back.
     */
    status: text("status").$type<"active" | "needs_reauth">().default("active").notNull(),
    /** Last time this connection produced a usable access token. */
    lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index("gmail_connections_user_idx").on(t.userId)]
);

export const outlookConnections = pgTable(
  "outlook_connections",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: text("user_id").notNull().unique(),
    emailAddress: text("email_address").notNull(),
    accessTokenEncrypted: text("access_token_encrypted").notNull(),
    refreshTokenEncrypted: text("refresh_token_encrypted"),
    tokenExpiresAt: timestamp("token_expires_at", { withTimezone: true }),
    scopes: text("scopes"),
    /**
     * Exactly two values. NOT "expired"/"revoked": disconnecting deletes the row, so a
     * third value nothing ever writes would recreate the bug this replaced — the column
     * was previously written only as "active", making every health check on it dead code.
     *
     * `needs_reauth` is written only on a token-level rejection (no refresh token, or the
     * provider returning invalid_grant), never on a transport failure — a provider outage
     * must not flag every account. Cleared by re-running OAuth, which is the only way back.
     */
    status: text("status").$type<"active" | "needs_reauth">().default("active").notNull(),
    /** Last time this connection produced a usable access token. */
    lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index("outlook_connections_user_idx").on(t.userId)]
);

export type ChatRecommendation = {
  contact_id?: string | null;
  recruiter_id?: string | null;
  name: string;
  reason: string;
  suggested_action: string;
  draft_message: string | null;
};

export const chatThreads = pgTable(
  "chat_threads",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: text("user_id").notNull(),
    title: text("title"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index("chat_threads_user_idx").on(t.userId),
    index("chat_threads_user_updated_idx").on(t.userId, t.updatedAt),
  ]
);

export const chatMessages = pgTable(
  "chat_messages",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    threadId: uuid("thread_id")
      .notNull()
      .references(() => chatThreads.id, { onDelete: "cascade" }),
    userId: text("user_id").notNull(),
    role: text("role").$type<"user" | "assistant">().notNull(),
    content: text("content").notNull(),
    recommendations: jsonb("recommendations").$type<ChatRecommendation[]>(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index("chat_messages_thread_idx").on(t.threadId),
    index("chat_messages_user_idx").on(t.userId),
  ]
);

/**
 * One row per AI provider call, written fire-and-forget from `src/lib/ai.ts`.
 *
 * Production is strictly BYOK (`allowEnvProviderKeys()` returns `!process.env.VERCEL`), so
 * this is not primarily a cost ledger — the spend is the user's. Its real jobs are showing
 * which accounts are actually using the product, and which ones are failing.
 *
 * Booleans are integers to match the house convention (`enabled`, `active`, `year_inferred`).
 * There is no FK on `user_id`: nothing in this schema has one, because it is a Clerk id.
 */
export const usageEvents = pgTable(
  "usage_events",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: text("user_id").notNull(),
    /** Dotted call-site id, e.g. "capture.parse", "chat.answer", "search.embed". */
    operation: text("operation").notNull(),
    provider: text("provider").$type<"gemini" | "openai" | "anthropic">().notNull(),
    model: text("model").notNull(),
    kind: text("kind")
      .$type<"completion" | "multimodal" | "embedding" | "transcription">()
      .notNull(),
    /**
     * Null means the provider did not report a count — Whisper bills per second of audio
     * and Gemini's embed endpoint returns no usage metadata. Null is information; a
     * fabricated zero is a lie that would get summed.
     */
    inputTokens: integer("input_tokens"),
    outputTokens: integer("output_tokens"),
    cachedInputTokens: integer("cached_input_tokens"),
    /**
     * USD × 1e6. Integers because floats accumulate error across SUM and `numeric` comes
     * back as a string anyway. Null when the model is absent from the price table — a
     * blank cell beats a confidently wrong dollar figure.
     */
    estimatedCostMicros: integer("estimated_cost_micros"),
    /** Whose key paid for it. "orbit" only ever happens off-Vercel (local dev). */
    keyOwner: text("key_owner").$type<"user" | "orbit">().notNull(),
    success: integer("success").notNull().default(1),
    /** Stable machine code, not the user-facing message — that is unqueryably high-cardinality. */
    errorKind: text("error_kind"),
    durationMs: integer("duration_ms"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index("usage_events_user_created_idx").on(t.userId, t.createdAt),
    index("usage_events_created_idx").on(t.createdAt),
    index("usage_events_model_idx").on(t.provider, t.model),
  ]
);

/**
 * Privileged admin actions. Small by construction — the admin console performs exactly two
 * kinds of write: comping a plan, and revealing one redacted record.
 *
 * Comps are why this exists. `comped_plan` outranks every real billing signal in
 * `resolvePlan`, has no expiry, and no webhook will ever correct it; `updated_at` is bumped
 * by a dozen unrelated writers, so without this table there is no record a comp happened.
 *
 * Action names, all written by `src/actions/admin.ts`:
 *   comp.grant · comp.revoke
 *   record.reveal · reveal.grant · reveal.revoke
 *   import.retry · import.cancel
 *   onboarding.reset · integration.disconnect · calendar.enable · calendar.disable
 *   account.suspend · account.unsuspend · account.delete
 *   export.download
 */
export const adminAuditLog = pgTable(
  "admin_audit_log",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    adminUserId: text("admin_user_id").notNull(),
    /** One of the names listed in this table's doc comment. */
    action: text("action").notNull(),
    targetUserId: text("target_user_id"),
    resourceType: text("resource_type"),
    resourceId: text("resource_id"),
    detail: jsonb("detail").$type<Record<string, unknown>>().default({}),
    reason: text("reason"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index("admin_audit_log_created_idx").on(t.createdAt),
    index("admin_audit_log_target_idx").on(t.targetUserId),
    index("admin_audit_log_action_idx").on(t.action, t.createdAt),
  ]
);

/**
 * One row per scheduled-job invocation.
 *
 * The row is written at START, not only at the end. Without that, "the cron never fired"
 * and "the cron fired and died" are the same observation — no row — and they need
 * completely different responses. A lambda killed at `maxDuration` never runs its
 * `finally`, so an end-only write loses precisely the runs worth seeing.
 *
 * A crashed run therefore leaves `status='running'` forever; that is resolved on read by
 * `deriveCronRunState`, not by a second cron watching the first.
 */
export const cronRuns = pgTable(
  "cron_runs",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    /** Dotted job id, same convention as `usage_events.operation`. */
    job: text("job").notNull(),
    status: text("status")
      .$type<"running" | "ok" | "partial" | "failed">()
      .default("running")
      .notNull(),
    trigger: text("trigger")
      .$type<"schedule" | "manual">()
      .default("schedule")
      .notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }).defaultNow().notNull(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    durationMs: integer("duration_ms"),
    /** Job-specific counters. jsonb so a second cron needs no migration. */
    stats: jsonb("stats").$type<Record<string, number | boolean>>().default({}).notNull(),
    error: text("error"),
  },
  (t) => [
    index("cron_runs_job_started_idx").on(t.job, t.startedAt),
    index("cron_runs_started_idx").on(t.startedAt),
  ]
);

/**
 * One row per inbound webhook delivery, including the ones that are rejected or ignored.
 *
 * A silently dropped `subscriptionItem.*` event desyncs billing from `user_settings`, which
 * every entitlement gate reads and nothing ever reconciles — so "an event arrived and
 * nothing happened" has to be a recordable outcome, not an absence.
 *
 * Deliberately NO unique index on (source, event_id). Every handler is already idempotent,
 * so a unique constraint would buy nothing and would destroy the retry count — and
 * "this event was delivered six times" is the single most useful thing this table says.
 */
export const webhookDeliveries = pgTable(
  "webhook_deliveries",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    source: text("source").default("clerk").notNull(),
    /**
     * The `svix-id` header. Clerk's event body carries no delivery id — `data.id` is the
     * resource — and this header is stable across retries and readable before signature
     * verification, which is what makes the rejection path recordable at all.
     */
    eventId: text("event_id"),
    /** Null when verification failed: there is no trustworthy body to read a type from. */
    eventType: text("event_type"),
    outcome: text("outcome")
      .$type<"handled" | "ignored" | "invalid" | "error">()
      .notNull(),
    /** Low-cardinality machine code, so this groups cleanly. See WEBHOOK_REASONS. */
    reason: text("reason"),
    targetUserId: text("target_user_id"),
    /** `data.id` — the Clerk resource, not the delivery. */
    resourceId: text("resource_id"),
    detail: jsonb("detail").$type<Record<string, unknown>>().default({}).notNull(),
    error: text("error"),
    durationMs: integer("duration_ms"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index("webhook_deliveries_created_idx").on(t.createdAt),
    index("webhook_deliveries_event_idx").on(t.eventId),
    index("webhook_deliveries_target_idx").on(t.targetUserId),
    index("webhook_deliveries_type_created_idx").on(t.eventType, t.createdAt),
  ]
);

/**
 * Failures that would otherwise vanish into a `catch {}`.
 *
 * Scoped deliberately narrowly — see `src/lib/error-events.ts` for the closed list of
 * call sites and, more importantly, the list of failures that must NOT be recorded here
 * because they are already captured elsewhere. This is not a logging framework, and the
 * moment it becomes one it should be replaced by a real one.
 *
 * `source` and `kind` are low-cardinality so both group cleanly; `message` is free text
 * and can only ever appear in a most-recent list, never in a GROUP BY.
 */
export const errorEvents = pgTable(
  "error_events",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    /** Dotted call-site id, e.g. "oauth.gmail.callback". */
    source: text("source").notNull(),
    kind: text("kind").notNull(),
    /** Null when the failure has no user — config errors, unauthenticated callbacks. */
    userId: text("user_id"),
    /** Verbatim system output, truncated. Same class as `imports.error_message`. */
    message: text("message"),
    context: jsonb("context").$type<Record<string, unknown>>().default({}).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index("error_events_created_idx").on(t.createdAt),
    index("error_events_source_created_idx").on(t.source, t.createdAt),
    index("error_events_user_created_idx").on(t.userId, t.createdAt),
  ]
);

/**
 * What users told us, unaggregated.
 *
 * Deliberately one table for three kinds rather than three tables: they are read together
 * ("what has anyone said lately?"), they share a shape, and at this volume the verbatims
 * matter far more than any per-kind aggregate. `score` is only meaningful for `pmf`.
 *
 * This is the only place in the schema that holds prose written by a user ABOUT ORBIT
 * rather than about a third party — which makes it the one free-text column an operator
 * can read without the privacy question that governs `contacts.notes`.
 */
export const feedback = pgTable(
  "feedback",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: text("user_id").notNull(),
    /**
     * `pmf` — the Sean Ellis question. `freeform` — unprompted. `churn_reason` — captured
     * at cancellation, the most valuable and least available of the three.
     */
    kind: text("kind").$type<"pmf" | "freeform" | "churn_reason">().notNull(),
    /** PMF only: 3 very disappointed, 2 somewhat, 1 not. Null for the other kinds. */
    score: integer("score"),
    text: text("text"),
    /** Where they were when they said it — route, plan, contact count. */
    context: jsonb("context").$type<Record<string, unknown>>().default({}).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index("feedback_kind_created_idx").on(t.kind, t.createdAt),
    index("feedback_user_created_idx").on(t.userId, t.createdAt),
  ]
);

/**
 * The landing page's "Interest list" — a mailing-list opt-in, not a signup gate. Anonymous,
 * so there's no `userId`: the only identity is the email itself.
 *
 * Deliberately not Clerk's `joinWaitlist()`. That call requires the whole instance's sign-up
 * mode to be "Waitlist", which would block this app's normal, already-live sign-up flow —
 * so this owns its own table instead, the same way `feedback` and `webhookDeliveries` do.
 */
export const interestListSignups = pgTable(
  "interest_list_signups",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    /** Normalized (trimmed + lowercased) by the server action before insert — the unique
     * index is a plain column, not a `lower()` expression, to stay covered by
     * `smoke-schema-ddl.ts`'s index-parity check the way `companies.nameNormalized` does. */
    email: text("email").notNull(),
    /** First-touch acquisition signal, same shape as `user_settings.signup_*`. */
    referrer: text("referrer"),
    utmSource: text("utm_source"),
    utmMedium: text("utm_medium"),
    utmCampaign: text("utm_campaign"),
    landingPath: text("landing_path"),
    /** Opaque, same convention as `user_settings.calendar_feed_token` — mints the one-click
     * unsubscribe link without exposing the row's uuid or requiring a session. */
    unsubscribeToken: text("unsubscribe_token").notNull(),
    unsubscribedAt: timestamp("unsubscribed_at", { withTimezone: true }),
    /**
     * Which planet the welcome email showed. Stored rather than recomputed so the note's
     * "you got Mercury" postscript stays true forever, and so the day-3 follow-up can show
     * the same one. See `WELCOME_PLANETS`.
     */
    welcomePlanet: text("welcome_planet"),
    /**
     * When the day-3 follow-up went out. Null means "still owed one"; the sweep claims a
     * row by stamping this before it sends, so a crash mid-batch cannot double-send.
     */
    followUpSentAt: timestamp("follow_up_sent_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("interest_list_signups_email_uidx").on(t.email),
    uniqueIndex("interest_list_signups_token_uidx").on(t.unsubscribeToken),
    index("interest_list_signups_created_idx").on(t.createdAt),
  ]
);

/**
 * Money, as events rather than as a headcount.
 *
 * The console previously derived MRR as `subscribers × $5`, which cannot see a mid-month
 * cancellation, a refund, or a plan change — it reports the same number the day before and
 * the day after someone leaves. This table records what each billing webhook MEANT
 * financially; `webhook_deliveries` already records that one arrived.
 *
 * `mrrDeltaCents` is signed and is the whole point: summing it over a period gives real
 * MRR movement. One-time revenue (Lifetime) carries `amountCents` with a zero delta, so it
 * never inflates a recurring figure.
 *
 * UNIQUE ON (source, event_id), unlike `webhook_deliveries` which deliberately has no such
 * constraint. That table wants the retry count — "this was delivered 6 times" is its best
 * signal. Here a redelivery would double-count money, and correctness must not depend on
 * every future reader remembering to deduplicate. The retry information is not lost; it
 * still lives one table over.
 */
export const billingEvents = pgTable(
  "billing_events",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    source: text("source").$type<"clerk" | "stripe">().notNull(),
    /** The provider's delivery id — `svix-id` for Clerk, the event id for Stripe. */
    eventId: text("event_id").notNull(),
    kind: text("kind")
      .$type<
        | "new"
        | "expansion"
        | "contraction"
        | "churn"
        | "reactivation"
        | "lifetime"
        | "refund"
        | "payment_failed"
      >()
      .notNull(),
    userId: text("user_id"),
    /** Cash moved, always positive. Zero for a pure status change. */
    amountCents: integer("amount_cents").default(0).notNull(),
    /** Signed change to recurring revenue. Zero for one-time and non-recurring events. */
    mrrDeltaCents: integer("mrr_delta_cents").default(0).notNull(),
    /** When it counts, which is not always when it arrived — webhooks lag and retry. */
    effectiveAt: timestamp("effective_at", { withTimezone: true }).notNull(),
    detail: jsonb("detail").$type<Record<string, unknown>>().default({}).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("billing_events_source_event_uidx").on(t.source, t.eventId),
    index("billing_events_effective_idx").on(t.effectiveAt),
    index("billing_events_user_effective_idx").on(t.userId, t.effectiveAt),
    index("billing_events_kind_effective_idx").on(t.kind, t.effectiveAt),
  ]
);

/**
 * What Orbit pays to keep the lights on, one row per provider per month.
 *
 * Entered by hand rather than pulled from an API. Five numbers a month does not justify a
 * third-party integration, an auth flow and a new failure mode — and the shape of this
 * table does not change when it eventually does, so automating later costs nothing now.
 *
 * Without this, "money out" is AI spend only, which is mostly the USER's spend (production
 * is strictly BYOK) — so gross margin was not merely unknown, it was systematically
 * misleading.
 */
export const infraCosts = pgTable(
  "infra_costs",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    provider: text("provider").notNull(),
    /** First day of the month it covers, so ordering and range queries are plain dates. */
    periodMonth: timestamp("period_month", { withTimezone: true }).notNull(),
    amountCents: integer("amount_cents").notNull(),
    note: text("note"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("infra_costs_provider_month_uidx").on(t.provider, t.periodMonth),
    index("infra_costs_month_idx").on(t.periodMonth),
  ]
);

/**
 * Every time a plan gate refused someone.
 *
 * NOT an error, and deliberately not stored as one. A free user hitting a paywall is the
 * product working; filing it under `error_events` would put "someone wanted to pay us" on
 * the Health screen next to broken OAuth tokens and corrupt the meaning of both.
 *
 * This is the only evidence of demand for a feature the user could not reach. A wall
 * somebody bounces off repeatedly is a feature they would pay for; a wall nobody ever
 * reaches is in the wrong tier. Neither fact is knowable from `usage_events`, which by
 * definition only records what did happen.
 *
 * `plan` is denormalised on purpose — the point of the row is what their plan was AT THE
 * TIME, and reading it back off `user_settings` later gives the answer for today instead.
 */
export const gateEvents = pgTable(
  "gate_events",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: text("user_id").notNull(),
    /** A `FeatureKey` from `@/lib/entitlements`, or "contacts" for the free cap. */
    feature: text("feature").notNull(),
    plan: text("plan").$type<"free" | "orbit" | "lifetime">().notNull(),
    /** Route or action that hit the wall, for locating it in the product. */
    context: jsonb("context").$type<Record<string, unknown>>().default({}).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index("gate_events_feature_created_idx").on(t.feature, t.createdAt),
    index("gate_events_user_created_idx").on(t.userId, t.createdAt),
  ]
);

/**
 * Surfaces an operator has hidden from every user. The one genuinely global table in the
 * schema — no `user_id`, because the whole point is that it applies to everybody.
 *
 * PRESENCE IS THE FLAG: a row exists only for a hidden surface, and unhiding deletes it.
 * Storing a boolean per surface instead would mean seeding a row for every entry in
 * `SURFACES`, so adding a surface to that registry would need a migration before it could
 * be toggled. This way the registry is free to grow in a single commit.
 *
 * `surface_key` is a key from `@/lib/surfaces` and deliberately has no foreign key to
 * anything — a key retired from the registry leaves a harmless orphan row rather than
 * blocking the deploy that retired it.
 */
export const appSurfaceFlags = pgTable("app_surface_flags", {
  surfaceKey: text("surface_key").primaryKey(),
  hiddenAt: timestamp("hidden_at", { withTimezone: true }).defaultNow().notNull(),
  /** The admin who hid it. Kept for the audit trail's benefit, not read by the app. */
  hiddenBy: text("hidden_by").notNull(),
});

/**
 * Manually-entered spend, for the YC-mode Runway page's burn calculation. No integration
 * exists to pull this automatically — Orbit has no bank/accounting connection.
 */
export const startupExpenses = pgTable("startup_expenses", {
  id: uuid("id").defaultRandom().primaryKey(),
  category: text("category").notNull(),
  amountUsd: real("amount_usd").notNull(),
  incurredAt: timestamp("incurred_at", { withTimezone: true }).notNull(),
  note: text("note"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

/** Point-in-time cash-on-hand entries. The latest row is "current" cash for Runway. */
export const cashSnapshots = pgTable("cash_snapshots", {
  id: uuid("id").defaultRandom().primaryKey(),
  asOf: timestamp("as_of", { withTimezone: true }).notNull(),
  balanceUsd: real("balance_usd").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

/** Manually-logged acquisition spend by channel, for the Unit Economics CAC calculation. */
export const acquisitionSpend = pgTable("acquisition_spend", {
  id: uuid("id").defaultRandom().primaryKey(),
  channel: text("channel").notNull(),
  amountUsd: real("amount_usd").notNull(),
  periodStart: timestamp("period_start", { withTimezone: true }).notNull(),
  periodEnd: timestamp("period_end", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export const fundraisingRounds = pgTable("fundraising_rounds", {
  id: uuid("id").defaultRandom().primaryKey(),
  name: text("name").notNull(),
  targetUsd: real("target_usd").notNull(),
  status: text("status").$type<"open" | "closed">().notNull().default("open"),
  closedAt: timestamp("closed_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

/** No FK-cascade delete: closing/deleting a round should not silently erase commitments. */
export const fundraisingInvestors = pgTable("fundraising_investors", {
  id: uuid("id").defaultRandom().primaryKey(),
  roundId: uuid("round_id").notNull().references(() => fundraisingRounds.id),
  name: text("name").notNull(),
  amountUsd: real("amount_usd").notNull(),
  committedAt: timestamp("committed_at", { withTimezone: true }).notNull(),
  note: text("note"),
});

export const contactsRelations = relations(contacts, ({ many }) => ({
  interactions: many(interactions),
  reminders: many(reminders),
  contactTags: many(contactTags),
  embeddings: many(contactEmbeddings),
}));

export const tagsRelations = relations(tags, ({ many }) => ({
  contactTags: many(contactTags),
}));

export const contactTagsRelations = relations(contactTags, ({ one }) => ({
  contact: one(contacts, {
    fields: [contactTags.contactId],
    references: [contacts.id],
  }),
  tag: one(tags, {
    fields: [contactTags.tagId],
    references: [tags.id],
  }),
}));

export const interactionsRelations = relations(interactions, ({ one }) => ({
  contact: one(contacts, {
    fields: [interactions.contactId],
    references: [contacts.id],
  }),
}));

export const reminderListsRelations = relations(reminderLists, ({ many }) => ({
  reminders: many(reminders),
}));

export const remindersRelations = relations(reminders, ({ one }) => ({
  contact: one(contacts, {
    fields: [reminders.contactId],
    references: [contacts.id],
  }),
  list: one(reminderLists, {
    fields: [reminders.listId],
    references: [reminderLists.id],
  }),
}));

export const suggestedRemindersRelations = relations(
  suggestedReminders,
  ({ one }) => ({
    contact: one(contacts, {
      fields: [suggestedReminders.contactId],
      references: [contacts.id],
    }),
  })
);

export const contactEmbeddingsRelations = relations(
  contactEmbeddings,
  ({ one }) => ({
    contact: one(contacts, {
      fields: [contactEmbeddings.contactId],
      references: [contacts.id],
    }),
  })
);

export const outreachCampaignsRelations = relations(
  outreachCampaigns,
  ({ many }) => ({
    prospects: many(outreachProspects),
  })
);

export const outreachProspectsRelations = relations(
  outreachProspects,
  ({ one, many }) => ({
    campaign: one(outreachCampaigns, {
      fields: [outreachProspects.campaignId],
      references: [outreachCampaigns.id],
    }),
    contact: one(contacts, {
      fields: [outreachProspects.contactId],
      references: [contacts.id],
    }),
    messages: many(outreachMessages),
  })
);

export const outreachMessagesRelations = relations(
  outreachMessages,
  ({ one }) => ({
    prospect: one(outreachProspects, {
      fields: [outreachMessages.prospectId],
      references: [outreachProspects.id],
    }),
  })
);

export const chatThreadsRelations = relations(chatThreads, ({ many }) => ({
  messages: many(chatMessages),
}));

export const chatMessagesRelations = relations(chatMessages, ({ one }) => ({
  thread: one(chatThreads, {
    fields: [chatMessages.threadId],
    references: [chatThreads.id],
  }),
}));

export const recruitersRelations = relations(recruiters, ({ many }) => ({
  links: many(userRecruiterLinks),
}));

export const userRecruiterLinksRelations = relations(
  userRecruiterLinks,
  ({ one }) => ({
    recruiter: one(recruiters, {
      fields: [userRecruiterLinks.recruiterId],
      references: [recruiters.id],
    }),
    contact: one(contacts, {
      fields: [userRecruiterLinks.contactId],
      references: [contacts.id],
    }),
  })
);

/**
 * Rolling-window request counters for the browser extension API.
 *
 * One row per user. The AI window is tracked separately and kept much tighter
 * because those calls spend the user's own provider credits.
 */
export const extensionUsage = pgTable("extension_usage", {
  userId: text("user_id").primaryKey(),
  windowStartedAt: timestamp("window_started_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
  requestCount: integer("request_count").default(0).notNull(),
  aiWindowStartedAt: timestamp("ai_window_started_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
  aiCount: integer("ai_count").default(0).notNull(),
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
});

export type Contact = typeof contacts.$inferSelect;
export type NewContact = typeof contacts.$inferInsert;
export type ExtensionUsage = typeof extensionUsage.$inferSelect;
export type Interaction = typeof interactions.$inferSelect;
export type Reminder = typeof reminders.$inferSelect;
export type ReminderList = typeof reminderLists.$inferSelect;
export type SuggestedReminder = typeof suggestedReminders.$inferSelect;
export type Tag = typeof tags.$inferSelect;
export type AiSuggestion = typeof aiSuggestions.$inferSelect;
export type ImportRecord = typeof imports.$inferSelect;
export type CalendarSubscription = typeof calendarSubscriptions.$inferSelect;
export type Company = typeof companies.$inferSelect;
export type UserGoal = typeof userGoals.$inferSelect;
export type OutreachCampaign = typeof outreachCampaigns.$inferSelect;
export type OutreachProspect = typeof outreachProspects.$inferSelect;
export type OutreachMessage = typeof outreachMessages.$inferSelect;
export type ChatThread = typeof chatThreads.$inferSelect;
export type ChatMessage = typeof chatMessages.$inferSelect;
export type Recruiter = typeof recruiters.$inferSelect;
export type UserRecruiterLink = typeof userRecruiterLinks.$inferSelect;
export type RecruiterMessage = typeof recruiterMessages.$inferSelect;
export type GmailConnection = typeof gmailConnections.$inferSelect;
export type UsageEvent = typeof usageEvents.$inferSelect;
export type NewUsageEvent = typeof usageEvents.$inferInsert;
export type AdminAuditEntry = typeof adminAuditLog.$inferSelect;
export type CronRun = typeof cronRuns.$inferSelect;
export type WebhookDelivery = typeof webhookDeliveries.$inferSelect;
export type ErrorEvent = typeof errorEvents.$inferSelect;
export type FeedbackEntry = typeof feedback.$inferSelect;
export type InterestListSignup = typeof interestListSignups.$inferSelect;
export type BillingEvent = typeof billingEvents.$inferSelect;
export type NewBillingEvent = typeof billingEvents.$inferInsert;
export type InfraCost = typeof infraCosts.$inferSelect;
export type GateEvent = typeof gateEvents.$inferSelect;
