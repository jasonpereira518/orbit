import { drizzle as drizzleNeon } from "drizzle-orm/neon-http";
import { neon } from "@neondatabase/serverless";
import { drizzle as drizzlePglite } from "drizzle-orm/pglite";
import { PGlite } from "@electric-sql/pglite";
import * as schema from "./schema";
import { formatVectorLiteral } from "@/lib/pgvector";
import path from "node:path";
import fs from "node:fs";

type Db =
  | ReturnType<typeof drizzleNeon<typeof schema>>
  | ReturnType<typeof drizzlePglite<typeof schema>>;

const globalForDb = globalThis as unknown as {
  orbitPglite?: PGlite;
  orbitNeonSql?: ReturnType<typeof neon>;
  orbitReady?: Promise<void>;
  orbitPgvector?: boolean;
};

// Resets on HMR so new DDL/columns are applied after schema changes.
let schemaReconciled: Promise<void> | undefined;

const DDL = `
CREATE TABLE IF NOT EXISTS user_settings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id text NOT NULL UNIQUE,
  ai_provider text DEFAULT 'gemini',
  gemini_api_key_encrypted text,
  openai_api_key_encrypted text,
  anthropic_api_key_encrypted text,
  ai_model text DEFAULT 'gemini-3.5-flash',
  onboarding_completed_at timestamptz,
  comped_plan text,
  lifetime_purchased_at timestamptz,
  stripe_customer_id text,
  subscription_plan text,
  subscription_status text,
  subscription_period_end timestamptz,
  comped_note text,
  comped_at timestamptz,
  comped_by text,
  last_active_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS companies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id text NOT NULL,
  name text NOT NULL,
  name_normalized text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS companies_user_idx ON companies(user_id);
CREATE UNIQUE INDEX IF NOT EXISTS companies_user_name_uidx ON companies(user_id, name_normalized);
CREATE TABLE IF NOT EXISTS contacts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id text NOT NULL,
  full_name text NOT NULL,
  first_name text,
  last_name text,
  preferred_name text,
  company text,
  company_id uuid REFERENCES companies(id) ON DELETE SET NULL,
  title text,
  location text,
  school text,
  email text,
  phone text,
  linkedin_url text,
  website text,
  profile_image_url text,
  relationship_score integer NOT NULL DEFAULT 2,
  priority_level integer NOT NULL DEFAULT 0,
  source text,
  industry text,
  met_context text,
  date_met timestamptz,
  how_met text,
  shared_interests jsonb DEFAULT '[]',
  key_facts jsonb DEFAULT '[]',
  opportunities jsonb DEFAULT '[]',
  first_interaction_at timestamptz,
  last_interaction_at timestamptz,
  next_follow_up_at timestamptz,
  follow_up_status text DEFAULT 'none',
  ai_summary text,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS contacts_user_id_idx ON contacts(user_id);
CREATE TABLE IF NOT EXISTS user_goals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id text NOT NULL,
  text text NOT NULL,
  active integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS user_goals_user_idx ON user_goals(user_id);
CREATE TABLE IF NOT EXISTS tags (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id text NOT NULL,
  name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS contact_tags (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contact_id uuid NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  tag_id uuid NOT NULL REFERENCES tags(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS interactions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id text NOT NULL,
  contact_id uuid NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  interaction_type text NOT NULL DEFAULT 'note',
  interaction_date timestamptz NOT NULL DEFAULT now(),
  same_day_order integer NOT NULL DEFAULT 0,
  source text,
  external_id text,
  raw_notes text,
  ai_summary text,
  topics jsonb DEFAULT '[]',
  action_items jsonb DEFAULT '[]',
  sentiment text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS reminder_lists (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id text NOT NULL,
  name text NOT NULL,
  name_normalized text NOT NULL,
  position integer NOT NULL DEFAULT 0,
  is_inbox integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS reminder_lists_user_idx ON reminder_lists(user_id);
CREATE UNIQUE INDEX IF NOT EXISTS reminder_lists_user_name_uidx ON reminder_lists(user_id, name_normalized);
CREATE TABLE IF NOT EXISTS reminders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id text NOT NULL,
  contact_id uuid REFERENCES contacts(id) ON DELETE CASCADE,
  list_id uuid REFERENCES reminder_lists(id) ON DELETE SET NULL,
  title text NOT NULL,
  description text,
  due_date timestamptz,
  status text NOT NULL DEFAULT 'pending',
  reminder_type text NOT NULL DEFAULT 'manual',
  action_kind text NOT NULL DEFAULT 'task',
  created_by text NOT NULL DEFAULT 'user',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS suggested_reminders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id text NOT NULL,
  contact_id uuid REFERENCES contacts(id) ON DELETE SET NULL,
  capture_batch_id uuid NOT NULL,
  title text NOT NULL,
  description text,
  raw_date_phrase text NOT NULL,
  due_date timestamptz NOT NULL,
  year_inferred integer NOT NULL DEFAULT 0,
  source_excerpt text NOT NULL,
  source_hash text NOT NULL,
  item_hash text NOT NULL,
  action_kind text NOT NULL DEFAULT 'task',
  confidence_score integer,
  status text NOT NULL DEFAULT 'pending',
  reminder_id uuid REFERENCES reminders(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz
);
CREATE INDEX IF NOT EXISTS suggested_reminders_user_status_idx ON suggested_reminders(user_id, status);
CREATE INDEX IF NOT EXISTS suggested_reminders_batch_idx ON suggested_reminders(capture_batch_id);
CREATE UNIQUE INDEX IF NOT EXISTS suggested_reminders_user_item_uidx ON suggested_reminders(user_id, item_hash);
CREATE TABLE IF NOT EXISTS imports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id text NOT NULL,
  import_type text NOT NULL,
  file_name text,
  status text NOT NULL DEFAULT 'pending',
  total_rows integer,
  rows_processed integer DEFAULT 0,
  contacts_created integer DEFAULT 0,
  contacts_updated integer DEFAULT 0,
  duplicates_found integer DEFAULT 0,
  error_message text,
  stats jsonb DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS import_job_rows (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  import_id uuid NOT NULL REFERENCES imports(id) ON DELETE CASCADE,
  user_id text NOT NULL,
  row_index integer NOT NULL,
  payload jsonb NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  contact_id uuid,
  error_message text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS import_job_rows_import_status_idx ON import_job_rows(import_id, status);
CREATE TABLE IF NOT EXISTS ai_suggestions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id text NOT NULL,
  suggestion_type text NOT NULL,
  title text NOT NULL,
  description text,
  related_contact_ids jsonb DEFAULT '[]',
  confidence_score integer,
  status text NOT NULL DEFAULT 'pending',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS contact_embeddings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id text NOT NULL,
  contact_id uuid NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  source_type text NOT NULL,
  source_id text,
  embedding jsonb NOT NULL,
  content text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS calendar_subscriptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id text NOT NULL,
  label text DEFAULT 'Calendar',
  ics_url text NOT NULL,
  self_email text,
  enabled integer NOT NULL DEFAULT 1,
  last_synced_at timestamptz,
  last_sync_status text,
  last_sync_error text,
  last_sync_stats jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS calendar_subscriptions_user_idx ON calendar_subscriptions(user_id);
CREATE INDEX IF NOT EXISTS contacts_company_idx ON contacts(user_id, company);
CREATE INDEX IF NOT EXISTS contacts_follow_up_idx ON contacts(user_id, next_follow_up_at);
CREATE INDEX IF NOT EXISTS tags_user_id_idx ON tags(user_id);
CREATE INDEX IF NOT EXISTS contact_tags_contact_idx ON contact_tags(contact_id);
CREATE INDEX IF NOT EXISTS interactions_contact_idx ON interactions(contact_id);
CREATE INDEX IF NOT EXISTS interactions_user_idx ON interactions(user_id);
CREATE INDEX IF NOT EXISTS interactions_user_type_idx ON interactions(user_id, interaction_type);
CREATE INDEX IF NOT EXISTS interactions_user_contact_type_date_idx ON interactions(user_id, contact_id, interaction_type, interaction_date);
CREATE UNIQUE INDEX IF NOT EXISTS interactions_user_external_uidx ON interactions(user_id, external_id) WHERE external_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS reminders_user_status_idx ON reminders(user_id, status);
CREATE INDEX IF NOT EXISTS reminders_due_idx ON reminders(user_id, due_date);
CREATE INDEX IF NOT EXISTS reminders_list_idx ON reminders(user_id, list_id);
CREATE INDEX IF NOT EXISTS ai_suggestions_user_idx ON ai_suggestions(user_id, status);
CREATE INDEX IF NOT EXISTS embeddings_user_idx ON contact_embeddings(user_id);
CREATE INDEX IF NOT EXISTS embeddings_contact_idx ON contact_embeddings(contact_id);
CREATE TABLE IF NOT EXISTS outreach_campaigns (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id text NOT NULL,
  name text NOT NULL,
  status text NOT NULL DEFAULT 'draft',
  audience_query text,
  audience_filters jsonb DEFAULT '{}',
  message_intent text,
  reply_cta text,
  tone text DEFAULT 'professional',
  default_channel text DEFAULT 'email',
  sequence_steps jsonb DEFAULT '[]',
  last_search_source text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS outreach_campaigns_user_idx ON outreach_campaigns(user_id, status);
CREATE TABLE IF NOT EXISTS outreach_prospects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id uuid NOT NULL REFERENCES outreach_campaigns(id) ON DELETE CASCADE,
  external_id text NOT NULL,
  contact_id uuid REFERENCES contacts(id) ON DELETE SET NULL,
  full_name text NOT NULL,
  title text,
  company text,
  email text,
  phone text,
  linkedin_url text,
  location text,
  enrichment jsonb DEFAULT '{}',
  status text NOT NULL DEFAULT 'suggested',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS outreach_prospects_campaign_idx ON outreach_prospects(campaign_id);
CREATE UNIQUE INDEX IF NOT EXISTS outreach_prospects_campaign_external_uidx ON outreach_prospects(campaign_id, external_id);
CREATE TABLE IF NOT EXISTS outreach_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  prospect_id uuid NOT NULL REFERENCES outreach_prospects(id) ON DELETE CASCADE,
  channel text NOT NULL,
  subject text,
  body text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'draft',
  step_index integer NOT NULL DEFAULT 0,
  parent_message_id uuid,
  scheduled_for timestamptz,
  outcome text,
  outcome_notes text,
  replied_at timestamptz,
  sent_at timestamptz,
  last_action_at timestamptz,
  error_message text,
  delivery_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS outreach_messages_prospect_idx ON outreach_messages(prospect_id);
CREATE INDEX IF NOT EXISTS outreach_messages_status_idx ON outreach_messages(status);
CREATE INDEX IF NOT EXISTS outreach_messages_outcome_idx ON outreach_messages(outcome);
CREATE INDEX IF NOT EXISTS outreach_messages_scheduled_idx ON outreach_messages(scheduled_for);
CREATE TABLE IF NOT EXISTS chat_threads (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id text NOT NULL,
  title text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS chat_threads_user_idx ON chat_threads(user_id);
CREATE INDEX IF NOT EXISTS chat_threads_user_updated_idx ON chat_threads(user_id, updated_at);
CREATE TABLE IF NOT EXISTS chat_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  thread_id uuid NOT NULL REFERENCES chat_threads(id) ON DELETE CASCADE,
  user_id text NOT NULL,
  role text NOT NULL,
  content text NOT NULL,
  recommendations jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS chat_messages_thread_idx ON chat_messages(thread_id);
CREATE INDEX IF NOT EXISTS chat_messages_user_idx ON chat_messages(user_id);
CREATE TABLE IF NOT EXISTS recruiters (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  full_name text NOT NULL,
  name_normalized text NOT NULL,
  firm text,
  firm_normalized text,
  specialty jsonb DEFAULT '[]',
  email text,
  email_normalized text,
  linkedin_url text,
  phone text,
  avg_rating integer NOT NULL DEFAULT 0,
  rating_count integer NOT NULL DEFAULT 0,
  log_count integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS recruiters_name_idx ON recruiters(name_normalized);
CREATE INDEX IF NOT EXISTS recruiters_firm_idx ON recruiters(firm_normalized);
CREATE INDEX IF NOT EXISTS recruiters_email_idx ON recruiters(email_normalized);
CREATE INDEX IF NOT EXISTS recruiters_rating_idx ON recruiters(avg_rating, log_count);
CREATE TABLE IF NOT EXISTS user_recruiter_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id text NOT NULL,
  recruiter_id uuid NOT NULL REFERENCES recruiters(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'planned',
  personal_rating integer,
  notes text,
  source text NOT NULL DEFAULT 'manual',
  contact_id uuid REFERENCES contacts(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS user_recruiter_links_user_idx ON user_recruiter_links(user_id);
CREATE INDEX IF NOT EXISTS user_recruiter_links_recruiter_idx ON user_recruiter_links(recruiter_id);
CREATE UNIQUE INDEX IF NOT EXISTS user_recruiter_links_user_recruiter_uidx ON user_recruiter_links(user_id, recruiter_id);
CREATE TABLE IF NOT EXISTS gmail_connections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id text NOT NULL UNIQUE,
  email_address text NOT NULL,
  access_token_encrypted text NOT NULL,
  refresh_token_encrypted text,
  token_expires_at timestamptz,
  scopes text,
  status text NOT NULL DEFAULT 'active',
  last_synced_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS gmail_connections_user_idx ON gmail_connections(user_id);
CREATE TABLE IF NOT EXISTS outlook_connections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id text NOT NULL UNIQUE,
  email_address text NOT NULL,
  access_token_encrypted text NOT NULL,
  refresh_token_encrypted text,
  token_expires_at timestamptz,
  scopes text,
  status text NOT NULL DEFAULT 'active',
  last_synced_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS outlook_connections_user_idx ON outlook_connections(user_id);
CREATE TABLE IF NOT EXISTS usage_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id text NOT NULL,
  operation text NOT NULL,
  provider text NOT NULL,
  model text NOT NULL,
  kind text NOT NULL,
  input_tokens integer,
  output_tokens integer,
  cached_input_tokens integer,
  estimated_cost_micros integer,
  key_owner text NOT NULL DEFAULT 'user',
  success integer NOT NULL DEFAULT 1,
  error_kind text,
  duration_ms integer,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS usage_events_user_created_idx ON usage_events(user_id, created_at);
CREATE INDEX IF NOT EXISTS usage_events_created_idx ON usage_events(created_at);
CREATE INDEX IF NOT EXISTS usage_events_model_idx ON usage_events(provider, model);
CREATE TABLE IF NOT EXISTS admin_audit_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  admin_user_id text NOT NULL,
  action text NOT NULL,
  target_user_id text,
  resource_type text,
  resource_id text,
  detail jsonb DEFAULT '{}',
  reason text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS admin_audit_log_created_idx ON admin_audit_log(created_at);
CREATE INDEX IF NOT EXISTS admin_audit_log_target_idx ON admin_audit_log(target_user_id);
`;

async function columnExists(client: PGlite, table: string, column: string) {
  const result = await client.query<{ exists: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = $1
         AND column_name = $2
     ) AS exists`,
    [table, column]
  );
  return Boolean(result.rows[0]?.exists);
}

async function ensureColumn(
  client: PGlite,
  table: string,
  column: string,
  definition: string
) {
  if (await columnExists(client, table, column)) return;
  await client.exec(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS ${column} ${definition}`);
}

async function migratePglite(client: PGlite) {
  await client.exec(DDL);

  // Older local DBs used an OpenAI key column name
  if (await columnExists(client, "user_settings", "openai_api_key_encrypted")) {
    if (!(await columnExists(client, "user_settings", "gemini_api_key_encrypted"))) {
      await client.exec(
        `ALTER TABLE user_settings RENAME COLUMN openai_api_key_encrypted TO gemini_api_key_encrypted`
      );
    }
  }

  // Columns added after the first local DB was created
  await ensureColumn(client, "user_settings", "onboarding_completed_at", "timestamptz");
  await ensureColumn(client, "user_settings", "onboarding_step", "text");
  await ensureColumn(client, "user_settings", "ai_provider", "text DEFAULT 'gemini'");
  await ensureColumn(client, "user_settings", "openai_api_key_encrypted", "text");
  await ensureColumn(client, "user_settings", "anthropic_api_key_encrypted", "text");
  await ensureColumn(client, "contacts", "preferred_name", "text");
  await ensureColumn(client, "contacts", "website", "text");
  await ensureColumn(client, "interactions", "external_id", "text");
  await ensureColumn(
    client,
    "interactions",
    "same_day_order",
    "integer NOT NULL DEFAULT 0"
  );
  await ensureColumn(
    client,
    "user_settings",
    "onboarding_completed_at",
    "timestamptz"
  );
  await ensureColumn(client, "contacts", "met_context", "text");
  await ensureColumn(client, "contacts", "date_met", "timestamptz");
  await ensureColumn(
    client,
    "contacts",
    "company_id",
    "uuid REFERENCES companies(id) ON DELETE SET NULL"
  );
  await ensureColumn(client, "imports", "error_message", "text");
  await ensureColumn(client, "imports", "stats", "jsonb DEFAULT '{}'");
  await ensureColumn(
    client,
    "imports",
    "updated_at",
    "timestamptz NOT NULL DEFAULT now()"
  );
  await ensureColumn(client, "imports", "total_rows", "integer");
  await ensureColumn(client, "user_settings", "apollo_api_key_encrypted", "text");
  await ensureColumn(client, "user_settings", "resend_api_key_encrypted", "text");
  await ensureColumn(client, "user_settings", "twilio_account_sid_encrypted", "text");
  await ensureColumn(client, "user_settings", "twilio_auth_token_encrypted", "text");
  await ensureColumn(client, "user_settings", "twilio_from_number", "text");
  await ensureColumn(client, "user_settings", "theme", "text");
  await ensureColumn(
    client,
    "user_settings",
    "desktop_notified_ids",
    "jsonb DEFAULT '[]'"
  );
  await ensureColumn(client, "contacts", "school", "text");
  await ensureColumn(client, "contacts", "profile_image_url", "text");
  await ensureColumn(
    client,
    "user_settings",
    "social_links",
    "jsonb DEFAULT '{}'"
  );
  await ensureColumn(
    client,
    "reminders",
    "list_id",
    "uuid REFERENCES reminder_lists(id) ON DELETE SET NULL"
  );
  await ensureColumn(
    client,
    "reminders",
    "action_kind",
    "text NOT NULL DEFAULT 'task'"
  );
  await ensureColumn(client, "outreach_campaigns", "reply_cta", "text");
  await ensureColumn(
    client,
    "outreach_campaigns",
    "sequence_steps",
    "jsonb DEFAULT '[]'"
  );
  await ensureColumn(client, "outreach_campaigns", "last_search_source", "text");
  await ensureColumn(
    client,
    "outreach_messages",
    "step_index",
    "integer NOT NULL DEFAULT 0"
  );
  await ensureColumn(client, "outreach_messages", "parent_message_id", "uuid");
  await ensureColumn(client, "outreach_messages", "scheduled_for", "timestamptz");
  await ensureColumn(client, "outreach_messages", "outcome", "text");
  await ensureColumn(client, "outreach_messages", "outcome_notes", "text");
  await ensureColumn(client, "outreach_messages", "replied_at", "timestamptz");
  await ensureColumn(client, "user_settings", "wizard_offered_at", "timestamptz");
  await ensureColumn(client, "user_settings", "wizard_step", "text");
  await ensureColumn(client, "user_settings", "wizard_completed_at", "timestamptz");
  await ensureColumn(client, "user_settings", "email", "text");
  await ensureColumn(client, "user_settings", "calendar_feed_token", "text");
  await ensureColumn(
    client,
    "user_settings",
    "calendar_feed_token_created_at",
    "timestamptz"
  );
  await ensureColumn(
    client,
    "user_settings",
    "calendar_feed_last_fetched_at",
    "timestamptz"
  );
  await ensureColumn(client, "contacts", "stated_closeness", "integer");

  try {
    await client.exec(
      `CREATE INDEX IF NOT EXISTS reminders_list_idx ON reminders(user_id, list_id)`
    );
  } catch {
    // Index may already exist
  }

  try {
    await client.exec(
      `CREATE UNIQUE INDEX IF NOT EXISTS user_settings_calendar_feed_token_uidx
       ON user_settings(calendar_feed_token)
       WHERE calendar_feed_token IS NOT NULL`
    );
  } catch {
    // Index may already exist
  }

  try {
    await client.exec(
      `CREATE INDEX IF NOT EXISTS outreach_messages_outcome_idx ON outreach_messages(outcome)`
    );
    await client.exec(
      `CREATE INDEX IF NOT EXISTS outreach_messages_scheduled_idx ON outreach_messages(scheduled_for)`
    );
  } catch {
    // Index may already exist
  }

  try {
    await client.exec(
      `CREATE UNIQUE INDEX IF NOT EXISTS interactions_user_external_uidx
       ON interactions(user_id, external_id)
       WHERE external_id IS NOT NULL`
    );
  } catch {
    // Existing duplicate external_ids — app-level dedupe still applies
  }

  try {
    await client.exec(
      `CREATE INDEX IF NOT EXISTS interactions_user_type_idx
       ON interactions(user_id, interaction_type)`
    );
    await client.exec(
      `CREATE INDEX IF NOT EXISTS interactions_user_contact_type_date_idx
       ON interactions(user_id, contact_id, interaction_type, interaction_date)`
    );
  } catch {
    // Index may already exist
  }

  // Billing columns. The paywall shipped these in the CREATE TABLE above and in a one-off
  // script, but `CREATE TABLE IF NOT EXISTS` never adds a column to a database that already
  // has the table — so a local .data/pglite predating the paywall stays broken until these
  // run. Cheap and idempotent; keep them rather than relying on the script being remembered.
  await ensureColumn(client, "user_settings", "comped_plan", "text");
  await ensureColumn(client, "user_settings", "lifetime_purchased_at", "timestamptz");
  await ensureColumn(client, "user_settings", "stripe_customer_id", "text");
  await ensureColumn(client, "user_settings", "subscription_plan", "text");
  await ensureColumn(client, "user_settings", "subscription_status", "text");
  await ensureColumn(client, "user_settings", "subscription_period_end", "timestamptz");
  await ensureColumn(client, "user_settings", "comped_note", "text");
  await ensureColumn(client, "user_settings", "comped_at", "timestamptz");
  await ensureColumn(client, "user_settings", "comped_by", "text");
  await ensureColumn(client, "user_settings", "last_active_at", "timestamptz");
}

/**
 * Normalizes a `db.execute()` result into a plain array.
 *
 * `drizzle-orm/neon-http` returns the rows directly; `drizzle-orm/pglite` wraps them in
 * `{ rows }`. Every raw-SQL caller has to handle both, so this is the one place that does.
 */
export function rowsOf<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  return ((result as { rows?: T[] } | null)?.rows ?? []) as T[];
}

export function isPgvectorAvailable() {
  return Boolean(globalForDb.orbitPgvector);
}

async function backfillEmbeddingVectors(sql: ReturnType<typeof neon>) {
  const result = await sql.query(
    `SELECT id, embedding
     FROM contact_embeddings
     WHERE embedding_vector IS NULL
       AND embedding IS NOT NULL
     LIMIT 500`
  );
  const rows = (Array.isArray(result) ? result : []) as Array<{
    id: string;
    embedding: number[];
  }>;

  for (const row of rows) {
    const embedding = row.embedding;
    if (!Array.isArray(embedding) || embedding.length === 0) continue;
    const literal = formatVectorLiteral(embedding);
    await sql.query(
      `UPDATE contact_embeddings
       SET embedding_vector = $1::vector
       WHERE id = $2`,
      [literal, row.id]
    );
  }
}

async function migratePgvector(sql: ReturnType<typeof neon>) {
  try {
    await sql.query(`CREATE EXTENSION IF NOT EXISTS vector`);
    await sql.query(
      `ALTER TABLE contact_embeddings ADD COLUMN IF NOT EXISTS embedding_vector vector(1536)`
    );
    await sql.query(
      `CREATE INDEX IF NOT EXISTS embeddings_vector_hnsw_idx
       ON contact_embeddings USING hnsw (embedding_vector vector_cosine_ops)`
    );
    await backfillEmbeddingVectors(sql);
    globalForDb.orbitPgvector = true;
  } catch {
    globalForDb.orbitPgvector = false;
  }
}

async function migrateNeon(sql: ReturnType<typeof neon>) {
  // Full bootstrap for empty Neon DBs (CREATE IF NOT EXISTS is idempotent).
  const statements = DDL.split(";")
    .map((s) => s.trim())
    .filter(Boolean);

  for (const statement of statements) {
    try {
      await sql.query(statement);
    } catch (err) {
      // Older Postgres variants / race — continue so later alters can recover,
      // but surface anything unexpected instead of swallowing it silently.
      const message = err instanceof Error ? err.message : String(err);
      if (!/already exists/i.test(message)) {
        console.error(`[db] DDL statement failed: ${statement}\n`, message);
      }
    }
  }

  // Incremental columns for older Neon DBs created before these existed.
  const alters = [
    `ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS onboarding_completed_at timestamptz`,
    `ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS onboarding_step text`,
    `ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS ai_provider text DEFAULT 'gemini'`,
    `ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS openai_api_key_encrypted text`,
    `ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS anthropic_api_key_encrypted text`,
    `ALTER TABLE contacts ADD COLUMN IF NOT EXISTS preferred_name text`,
    `ALTER TABLE contacts ADD COLUMN IF NOT EXISTS website text`,
    `ALTER TABLE contacts ADD COLUMN IF NOT EXISTS met_context text`,
    `ALTER TABLE contacts ADD COLUMN IF NOT EXISTS date_met timestamptz`,
    `ALTER TABLE contacts ADD COLUMN IF NOT EXISTS company_id uuid`,
    `ALTER TABLE interactions ADD COLUMN IF NOT EXISTS external_id text`,
    `ALTER TABLE interactions ADD COLUMN IF NOT EXISTS same_day_order integer NOT NULL DEFAULT 0`,
    `ALTER TABLE imports ADD COLUMN IF NOT EXISTS error_message text`,
    `ALTER TABLE imports ADD COLUMN IF NOT EXISTS stats jsonb DEFAULT '{}'`,
    `ALTER TABLE imports ADD COLUMN IF NOT EXISTS updated_at timestamptz DEFAULT now()`,
    `ALTER TABLE imports ADD COLUMN IF NOT EXISTS total_rows integer`,
    `ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS apollo_api_key_encrypted text`,
    `ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS resend_api_key_encrypted text`,
    `ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS twilio_account_sid_encrypted text`,
    `ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS twilio_auth_token_encrypted text`,
    `ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS twilio_from_number text`,
    `ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS theme text`,
    `ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS desktop_notified_ids jsonb DEFAULT '[]'`,
    `ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS social_links jsonb DEFAULT '{}'`,
    `ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS comped_plan text`,
    `ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS lifetime_purchased_at timestamptz`,
    `ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS stripe_customer_id text`,
    `ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS subscription_plan text`,
    `ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS subscription_status text`,
    `ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS subscription_period_end timestamptz`,
    `ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS comped_note text`,
    `ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS comped_at timestamptz`,
    `ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS comped_by text`,
    `ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS last_active_at timestamptz`,
    `CREATE INDEX IF NOT EXISTS usage_events_user_created_idx ON usage_events(user_id, created_at)`,
    `CREATE INDEX IF NOT EXISTS usage_events_created_idx ON usage_events(created_at)`,
    `CREATE INDEX IF NOT EXISTS usage_events_model_idx ON usage_events(provider, model)`,
    `CREATE INDEX IF NOT EXISTS admin_audit_log_created_idx ON admin_audit_log(created_at)`,
    `CREATE INDEX IF NOT EXISTS admin_audit_log_target_idx ON admin_audit_log(target_user_id)`,
    `ALTER TABLE contacts ADD COLUMN IF NOT EXISTS school text`,
    `ALTER TABLE contacts ADD COLUMN IF NOT EXISTS profile_image_url text`,
    `CREATE INDEX IF NOT EXISTS companies_user_idx ON companies(user_id)`,
    `CREATE UNIQUE INDEX IF NOT EXISTS companies_user_name_uidx ON companies(user_id, name_normalized)`,
    `CREATE INDEX IF NOT EXISTS user_goals_user_idx ON user_goals(user_id)`,
    `CREATE INDEX IF NOT EXISTS contacts_company_idx ON contacts(user_id, company)`,
    `CREATE INDEX IF NOT EXISTS contacts_follow_up_idx ON contacts(user_id, next_follow_up_at)`,
    `CREATE INDEX IF NOT EXISTS tags_user_id_idx ON tags(user_id)`,
    `CREATE INDEX IF NOT EXISTS contact_tags_contact_idx ON contact_tags(contact_id)`,
    `CREATE INDEX IF NOT EXISTS interactions_contact_idx ON interactions(contact_id)`,
    `CREATE INDEX IF NOT EXISTS interactions_user_idx ON interactions(user_id)`,
    `CREATE UNIQUE INDEX IF NOT EXISTS interactions_user_external_uidx ON interactions(user_id, external_id) WHERE external_id IS NOT NULL`,
    `CREATE INDEX IF NOT EXISTS reminders_user_status_idx ON reminders(user_id, status)`,
    `CREATE INDEX IF NOT EXISTS reminders_due_idx ON reminders(user_id, due_date)`,
    `ALTER TABLE reminders ADD COLUMN IF NOT EXISTS list_id uuid REFERENCES reminder_lists(id) ON DELETE SET NULL`,
    `ALTER TABLE reminders ADD COLUMN IF NOT EXISTS action_kind text NOT NULL DEFAULT 'task'`,
    `CREATE INDEX IF NOT EXISTS reminders_list_idx ON reminders(user_id, list_id)`,
    `ALTER TABLE outreach_campaigns ADD COLUMN IF NOT EXISTS reply_cta text`,
    `ALTER TABLE outreach_campaigns ADD COLUMN IF NOT EXISTS sequence_steps jsonb DEFAULT '[]'`,
    `ALTER TABLE outreach_campaigns ADD COLUMN IF NOT EXISTS last_search_source text`,
    `ALTER TABLE outreach_messages ADD COLUMN IF NOT EXISTS step_index integer NOT NULL DEFAULT 0`,
    `ALTER TABLE outreach_messages ADD COLUMN IF NOT EXISTS parent_message_id uuid`,
    `ALTER TABLE outreach_messages ADD COLUMN IF NOT EXISTS scheduled_for timestamptz`,
    `ALTER TABLE outreach_messages ADD COLUMN IF NOT EXISTS outcome text`,
    `ALTER TABLE outreach_messages ADD COLUMN IF NOT EXISTS outcome_notes text`,
    `ALTER TABLE outreach_messages ADD COLUMN IF NOT EXISTS replied_at timestamptz`,
    `CREATE INDEX IF NOT EXISTS outreach_messages_outcome_idx ON outreach_messages(outcome)`,
    `CREATE INDEX IF NOT EXISTS outreach_messages_scheduled_idx ON outreach_messages(scheduled_for)`,
    `CREATE INDEX IF NOT EXISTS ai_suggestions_user_idx ON ai_suggestions(user_id, status)`,
    `CREATE INDEX IF NOT EXISTS embeddings_user_idx ON contact_embeddings(user_id)`,
    `CREATE INDEX IF NOT EXISTS embeddings_contact_idx ON contact_embeddings(contact_id)`,
    `ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS wizard_offered_at timestamptz`,
    `ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS wizard_step text`,
    `ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS wizard_completed_at timestamptz`,
    `ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS email text`,
    `ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS calendar_feed_token text`,
    `ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS calendar_feed_token_created_at timestamptz`,
    `ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS calendar_feed_last_fetched_at timestamptz`,
    `CREATE UNIQUE INDEX IF NOT EXISTS user_settings_calendar_feed_token_uidx ON user_settings(calendar_feed_token) WHERE calendar_feed_token IS NOT NULL`,
    `ALTER TABLE contacts ADD COLUMN IF NOT EXISTS stated_closeness integer`,
  ];

  for (const statement of alters) {
    try {
      await sql.query(statement);
    } catch (err) {
      // Older Postgres variants / race — ignore "already exists"-style failures,
      // but surface anything else so real DDL drift doesn't fail silently.
      const message = err instanceof Error ? err.message : String(err);
      if (!/already exists/i.test(message)) {
        console.error(`[db] DDL statement failed: ${statement}\n`, message);
      }
    }
  }

  await migratePgvector(sql);
}

async function ensureReady(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL?.trim();

  if (databaseUrl) {
    if (!globalForDb.orbitNeonSql) {
      globalForDb.orbitNeonSql = neon(databaseUrl);
    }
    return;
  }

  if (!globalForDb.orbitPglite) {
    const dataDir = path.join(process.cwd(), ".data", "pglite");
    fs.mkdirSync(dataDir, { recursive: true });
    // Absolute string path — requires serverExternalPackages for @electric-sql/pglite
    globalForDb.orbitPglite = await PGlite.create({ dataDir });
  }

  await globalForDb.orbitPglite.waitReady;
}

export async function getDb(): Promise<Db> {
  if (!globalForDb.orbitReady) {
    globalForDb.orbitReady = ensureReady().catch((err) => {
      globalForDb.orbitReady = undefined;
      throw err;
    });
  }
  await globalForDb.orbitReady;

  if (!schemaReconciled) {
    schemaReconciled = (async () => {
      if (globalForDb.orbitNeonSql) {
        await migrateNeon(globalForDb.orbitNeonSql!);
      } else {
        await migratePglite(globalForDb.orbitPglite!);
      }
    })().catch((err) => {
      schemaReconciled = undefined;
      throw err;
    });
  }
  await schemaReconciled;

  // Rebuild the drizzle wrapper each call so schema HMR picks up new relations.
  if (globalForDb.orbitNeonSql) {
    return drizzleNeon(globalForDb.orbitNeonSql, { schema }) as Db;
  }
  return drizzlePglite(globalForDb.orbitPglite!, { schema });
}

export { schema };
