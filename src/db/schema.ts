import {
  pgTable,
  text,
  timestamp,
  integer,
  jsonb,
  uuid,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";

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
  theme: text("theme").$type<"light" | "dark" | "system">(),
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
    website: text("website"),
    profileImageUrl: text("profile_image_url"),
    relationshipScore: integer("relationship_score").default(2).notNull(),
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
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index("contacts_user_id_idx").on(t.userId),
    index("contacts_company_idx").on(t.userId, t.company),
    index("contacts_follow_up_idx").on(t.userId, t.nextFollowUpAt),
  ]
);

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

export type ImportStats = {
  skipped?: number;
  messagesImported?: number;
  meetingsLogged?: number;
  remindersCreated?: number;
  contactsEnriched?: number;
  eventsProcessed?: number;
  /** Contact ids touched during a multi-chunk messages import. */
  touchedContactIds?: string[];
};

export const imports = pgTable("imports", {
  id: uuid("id").defaultRandom().primaryKey(),
  userId: text("user_id").notNull(),
  importType: text("import_type").notNull(),
  fileName: text("file_name"),
  status: text("status").default("pending").notNull(),
  rowsProcessed: integer("rows_processed").default(0),
  contactsCreated: integer("contacts_created").default(0),
  contactsUpdated: integer("contacts_updated").default(0),
  duplicatesFound: integer("duplicates_found").default(0),
  errorMessage: text("error_message"),
  stats: jsonb("stats").$type<ImportStats>().default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

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
    tone: text("tone").default("professional"),
    defaultChannel: text("default_channel").default("email"),
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
    status: text("status").default("active").notNull(),
    lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index("gmail_connections_user_idx").on(t.userId)]
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

export type Contact = typeof contacts.$inferSelect;
export type NewContact = typeof contacts.$inferInsert;
export type Interaction = typeof interactions.$inferSelect;
export type Reminder = typeof reminders.$inferSelect;
export type ReminderList = typeof reminderLists.$inferSelect;
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
export type GmailConnection = typeof gmailConnections.$inferSelect;
