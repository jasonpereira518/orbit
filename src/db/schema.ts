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
    title: text("title").notNull(),
    description: text("description"),
    dueDate: timestamp("due_date", { withTimezone: true }),
    status: text("status").default("pending").notNull(),
    reminderType: text("reminder_type").default("manual").notNull(),
    createdBy: text("created_by").default("user").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index("reminders_user_status_idx").on(t.userId, t.status),
    index("reminders_due_idx").on(t.userId, t.dueDate),
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

export const remindersRelations = relations(reminders, ({ one }) => ({
  contact: one(contacts, {
    fields: [reminders.contactId],
    references: [contacts.id],
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

export type Contact = typeof contacts.$inferSelect;
export type NewContact = typeof contacts.$inferInsert;
export type Interaction = typeof interactions.$inferSelect;
export type Reminder = typeof reminders.$inferSelect;
export type Tag = typeof tags.$inferSelect;
export type AiSuggestion = typeof aiSuggestions.$inferSelect;
export type ImportRecord = typeof imports.$inferSelect;
export type CalendarSubscription = typeof calendarSubscriptions.$inferSelect;
export type Company = typeof companies.$inferSelect;
export type UserGoal = typeof userGoals.$inferSelect;
