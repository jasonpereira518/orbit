import { drizzle as drizzleNeon } from "drizzle-orm/neon-http";
import type { BatchItem } from "drizzle-orm/batch";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { neon } from "@neondatabase/serverless";
import { drizzle as drizzlePglite } from "drizzle-orm/pglite";
import { PGlite } from "@electric-sql/pglite";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import * as schema from "./schema";
import { formatVectorLiteral } from "@/lib/pgvector";
import { noteQuery } from "@/lib/query-counter";
import path from "node:path";
import fs from "node:fs";

/**
 * Drizzle's logger hook is the only place every statement funnels through regardless of
 * driver, which is why the statement counter hangs off it rather than off `db.execute`.
 * It logs nothing — `logQuery` is used purely as a per-statement callback.
 */
const countingLogger = { logQuery: (query: string) => noteQuery(query) };

type Db =
  | ReturnType<typeof drizzleNeon<typeof schema>>
  | ReturnType<typeof drizzlePglite<typeof schema>>;

const globalForDb = globalThis as unknown as {
  orbitPglite?: PGlite;
  orbitNeonSql?: ReturnType<typeof neon>;
  orbitReady?: Promise<void>;
  orbitPgvector?: boolean;
  orbitTrigram?: boolean;
  orbitDrizzle?: Db;
};

// Resets on HMR so new DDL/columns are applied after schema changes.
let schemaReconciled: Promise<void> | undefined;

export const DDL = `
CREATE TABLE IF NOT EXISTS user_settings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id text NOT NULL UNIQUE,
  ai_provider text DEFAULT 'gemini',
  gemini_api_key_encrypted text,
  openai_api_key_encrypted text,
  anthropic_api_key_encrypted text,
  ai_model text DEFAULT 'gemini-3.5-flash',
  onboarding_completed_at timestamptz,
  first_name text,
  last_name text,
  profile_image_url text,
  signup_referrer text,
  signup_utm_source text,
  signup_utm_medium text,
  signup_utm_campaign text,
  signup_landing_path text,
  signup_attributed_at timestamptz,
  comped_plan text,
  lifetime_purchased_at timestamptz,
  stripe_customer_id text,
  subscription_plan text,
  subscription_status text,
  subscription_period_end timestamptz,
  subscription_monthly_cents integer,
  subscription_interval text,
  comped_note text,
  comped_at timestamptz,
  comped_by text,
  last_active_at timestamptz,
  recruiter_sharing integer NOT NULL DEFAULT 0,
  suspended_at timestamptz,
  suspended_reason text,
  suspended_by text,
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
  x_handle text,
  website text,
  profile_image_url text,
  relationship_score integer NOT NULL DEFAULT 2,
  priority_level integer NOT NULL DEFAULT 0,
  source text,
  industry text,
  constellation_pin text,
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
  embedding_stale_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS contacts_user_id_idx ON contacts(user_id);
CREATE INDEX IF NOT EXISTS contacts_user_linkedin_idx ON contacts(user_id, linkedin_url);
CREATE INDEX IF NOT EXISTS contacts_user_x_idx ON contacts(user_id, x_handle);
CREATE TABLE IF NOT EXISTS extension_usage (
  user_id text PRIMARY KEY,
  window_started_at timestamptz NOT NULL DEFAULT now(),
  request_count integer NOT NULL DEFAULT 0,
  ai_window_started_at timestamptz NOT NULL DEFAULT now(),
  ai_count integer NOT NULL DEFAULT 0,
  last_seen_at timestamptz
);
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
  note_batch_id uuid,
  raw_notes text,
  ai_summary text,
  topics jsonb DEFAULT '[]',
  action_items jsonb DEFAULT '[]',
  sentiment text,
  direction text,
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
  note_batch_id uuid,
  source_interaction_id uuid REFERENCES interactions(id) ON DELETE SET NULL,
  action_item_id uuid,
  source_excerpt text,
  raw_date_phrase text,
  date_basis text,
  item_hash text,
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
CREATE TABLE IF NOT EXISTS note_batches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id text NOT NULL,
  source_hash text NOT NULL,
  source_text text NOT NULL,
  entry_point text NOT NULL DEFAULT 'capture',
  seed_contact_id uuid,
  anchor_date timestamptz NOT NULL,
  anchor_basis text NOT NULL DEFAULT 'upload',
  status text NOT NULL DEFAULT 'saved',
  result jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  undone_at timestamptz
);
CREATE INDEX IF NOT EXISTS note_batches_user_created_idx ON note_batches(user_id, created_at);
CREATE INDEX IF NOT EXISTS note_batches_user_source_idx ON note_batches(user_id, source_hash);
CREATE TABLE IF NOT EXISTS interaction_mentions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id text NOT NULL,
  interaction_id uuid NOT NULL REFERENCES interactions(id) ON DELETE CASCADE,
  contact_id uuid NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  mention_text text NOT NULL,
  confidence real NOT NULL,
  matched_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS interaction_mentions_interaction_contact_uidx ON interaction_mentions(interaction_id, contact_id);
CREATE INDEX IF NOT EXISTS interaction_mentions_user_contact_idx ON interaction_mentions(user_id, contact_id);
CREATE TABLE IF NOT EXISTS action_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id text NOT NULL,
  contact_id uuid NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  interaction_id uuid NOT NULL REFERENCES interactions(id) ON DELETE CASCADE,
  text text NOT NULL,
  position integer NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'open',
  completed_at timestamptz,
  item_hash text NOT NULL,
  reminder_id uuid REFERENCES reminders(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS action_items_user_item_hash_uidx ON action_items(user_id, item_hash);
CREATE INDEX IF NOT EXISTS action_items_user_contact_status_idx ON action_items(user_id, contact_id, status);
CREATE TABLE IF NOT EXISTS contact_briefs (
  contact_id uuid PRIMARY KEY REFERENCES contacts(id) ON DELETE CASCADE,
  user_id text NOT NULL,
  standing text NOT NULL,
  recent_discussions jsonb NOT NULL DEFAULT '[]',
  generated_at timestamptz NOT NULL DEFAULT now(),
  basis_interaction_id uuid,
  model text
);
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
  stall_resumes integer NOT NULL DEFAULT 0,
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
CREATE TABLE IF NOT EXISTS contact_profiles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id text NOT NULL,
  contact_id uuid NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  headline text,
  about text,
  skills jsonb NOT NULL DEFAULT '[]',
  certifications jsonb NOT NULL DEFAULT '[]',
  volunteering jsonb NOT NULL DEFAULT '[]',
  publications jsonb NOT NULL DEFAULT '[]',
  source text NOT NULL,
  source_url text,
  adapter_version text,
  warnings jsonb NOT NULL DEFAULT '[]',
  captured_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS contact_experiences (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id text NOT NULL,
  contact_id uuid NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  kind text NOT NULL,
  organization text NOT NULL,
  organization_normalized text NOT NULL,
  title text,
  field_of_study text,
  location text,
  description text,
  start_year integer,
  start_month integer,
  end_year integer,
  end_month integer,
  is_current boolean NOT NULL DEFAULT false,
  sort_index integer NOT NULL DEFAULT 0,
  source text NOT NULL,
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
CREATE INDEX IF NOT EXISTS interactions_user_contact_direction_idx ON interactions(user_id, contact_id, direction) WHERE interaction_type = 'linkedin_message';
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
  shared_to_pool integer NOT NULL DEFAULT 1,
  ai_summary text,
  companies_mentioned jsonb DEFAULT '[]',
  roles_discussed jsonb DEFAULT '[]',
  first_email_at timestamptz,
  last_email_at timestamptz,
  email_count integer NOT NULL DEFAULT 0,
  gmail_thread_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS user_recruiter_links_user_idx ON user_recruiter_links(user_id);
CREATE INDEX IF NOT EXISTS user_recruiter_links_recruiter_idx ON user_recruiter_links(recruiter_id);
CREATE UNIQUE INDEX IF NOT EXISTS user_recruiter_links_user_recruiter_uidx ON user_recruiter_links(user_id, recruiter_id);
CREATE TABLE IF NOT EXISTS recruiter_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id text NOT NULL,
  recruiter_id uuid NOT NULL REFERENCES recruiters(id) ON DELETE CASCADE,
  intent text NOT NULL,
  subject text NOT NULL,
  body text NOT NULL,
  status text NOT NULL DEFAULT 'draft',
  gmail_message_id text,
  gmail_thread_id text,
  sent_at timestamptz,
  error_message text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS recruiter_messages_user_idx ON recruiter_messages(user_id, status);
CREATE INDEX IF NOT EXISTS recruiter_messages_recruiter_idx ON recruiter_messages(recruiter_id);
CREATE INDEX IF NOT EXISTS recruiter_messages_sent_idx ON recruiter_messages(user_id, sent_at);
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
  sync_cursor jsonb,
  next_sync_at timestamptz,
  sync_status text,
  sync_started_at timestamptz,
  sync_error text,
  sync_failures integer NOT NULL DEFAULT 0,
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
  sync_cursor jsonb,
  next_sync_at timestamptz,
  sync_status text,
  sync_started_at timestamptz,
  sync_error text,
  sync_failures integer NOT NULL DEFAULT 0,
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
CREATE TABLE IF NOT EXISTS api_keys (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id text NOT NULL,
  name text NOT NULL,
  kind text NOT NULL DEFAULT 'api',
  prefix text NOT NULL,
  key_hash text NOT NULL,
  scopes jsonb NOT NULL DEFAULT '["read"]',
  last_used_at timestamptz,
  revoked_at timestamptz,
  revoked_reason text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS api_keys_hash_uidx ON api_keys(key_hash);
CREATE INDEX IF NOT EXISTS api_keys_user_idx ON api_keys(user_id);
CREATE TABLE IF NOT EXISTS api_idempotency_keys (
  user_id text NOT NULL,
  idempotency_key text NOT NULL,
  request_hash text NOT NULL,
  status_code integer NOT NULL,
  response_body jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS api_idempotency_uidx ON api_idempotency_keys(user_id, idempotency_key);
CREATE TABLE IF NOT EXISTS webhook_endpoints (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id text NOT NULL,
  url text NOT NULL,
  secret_encrypted text NOT NULL,
  event_types jsonb NOT NULL DEFAULT '[]',
  description text,
  status text NOT NULL DEFAULT 'pending',
  consecutive_failures integer NOT NULL DEFAULT 0,
  disabled_at timestamptz,
  disabled_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS webhook_endpoints_user_idx ON webhook_endpoints(user_id);
CREATE TABLE IF NOT EXISTS outbound_webhook_deliveries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id text NOT NULL,
  endpoint_id uuid NOT NULL REFERENCES webhook_endpoints(id) ON DELETE CASCADE,
  event_id text NOT NULL,
  event_type text NOT NULL,
  payload jsonb NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  attempts integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz,
  last_status_code integer,
  last_error text,
  last_attempted_at timestamptz,
  delivered_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS outbound_deliveries_endpoint_event_uidx ON outbound_webhook_deliveries(endpoint_id, event_id);
CREATE INDEX IF NOT EXISTS outbound_deliveries_due_idx ON outbound_webhook_deliveries(status, next_attempt_at);
CREATE INDEX IF NOT EXISTS outbound_deliveries_user_created_idx ON outbound_webhook_deliveries(user_id, created_at);
CREATE TABLE IF NOT EXISTS cron_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job text NOT NULL,
  status text NOT NULL DEFAULT 'running',
  trigger text NOT NULL DEFAULT 'schedule',
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  duration_ms integer,
  stats jsonb NOT NULL DEFAULT '{}',
  error text
);
CREATE INDEX IF NOT EXISTS cron_runs_job_started_idx ON cron_runs(job, started_at);
CREATE INDEX IF NOT EXISTS cron_runs_started_idx ON cron_runs(started_at);
CREATE TABLE IF NOT EXISTS ops_alert_state (
  id text PRIMARY KEY,
  severity text NOT NULL,
  active boolean NOT NULL DEFAULT true,
  opened_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  last_notified_at timestamptz,
  notify_count integer NOT NULL DEFAULT 0,
  detail jsonb NOT NULL DEFAULT '{}',
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS rate_limit_buckets (
  bucket text PRIMARY KEY,
  window_started_at timestamptz NOT NULL DEFAULT now(),
  count integer NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS webhook_deliveries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source text NOT NULL DEFAULT 'clerk',
  event_id text,
  event_type text,
  outcome text NOT NULL,
  reason text,
  target_user_id text,
  resource_id text,
  detail jsonb NOT NULL DEFAULT '{}',
  error text,
  duration_ms integer,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS webhook_deliveries_created_idx ON webhook_deliveries(created_at);
CREATE INDEX IF NOT EXISTS webhook_deliveries_event_idx ON webhook_deliveries(event_id);
CREATE INDEX IF NOT EXISTS webhook_deliveries_target_idx ON webhook_deliveries(target_user_id);
CREATE INDEX IF NOT EXISTS webhook_deliveries_type_created_idx ON webhook_deliveries(event_type, created_at);
CREATE TABLE IF NOT EXISTS error_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source text NOT NULL,
  kind text NOT NULL,
  user_id text,
  message text,
  context jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS error_events_created_idx ON error_events(created_at);
CREATE INDEX IF NOT EXISTS error_events_source_created_idx ON error_events(source, created_at);
CREATE INDEX IF NOT EXISTS error_events_user_created_idx ON error_events(user_id, created_at);
CREATE TABLE IF NOT EXISTS feedback (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id text NOT NULL,
  kind text NOT NULL,
  score integer,
  text text,
  area text,
  category text,
  status text NOT NULL DEFAULT 'new',
  status_changed_at timestamptz,
  status_changed_by text,
  resolution_note text,
  context jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS feedback_screenshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  feedback_id uuid NOT NULL REFERENCES feedback(id) ON DELETE CASCADE,
  user_id text NOT NULL,
  position integer NOT NULL DEFAULT 0,
  note text,
  storage text NOT NULL,
  blob_url text,
  inline_data text,
  content_type text NOT NULL,
  byte_size integer NOT NULL,
  width integer,
  height integer,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS feedback_kind_created_idx ON feedback(kind, created_at);
CREATE INDEX IF NOT EXISTS feedback_user_created_idx ON feedback(user_id, created_at);
CREATE INDEX IF NOT EXISTS feedback_status_created_idx ON feedback(status, created_at);
CREATE INDEX IF NOT EXISTS feedback_screenshots_feedback_idx ON feedback_screenshots(feedback_id, position);
CREATE INDEX IF NOT EXISTS feedback_screenshots_user_idx ON feedback_screenshots(user_id);
CREATE TABLE IF NOT EXISTS interest_list_signups (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL,
  referrer text,
  utm_source text,
  utm_medium text,
  utm_campaign text,
  landing_path text,
  unsubscribe_token text NOT NULL,
  unsubscribed_at timestamptz,
  welcome_planet text,
  follow_up_sent_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS interest_list_signups_email_uidx ON interest_list_signups(email);
CREATE UNIQUE INDEX IF NOT EXISTS interest_list_signups_token_uidx ON interest_list_signups(unsubscribe_token);
CREATE INDEX IF NOT EXISTS interest_list_signups_created_idx ON interest_list_signups(created_at);
CREATE TABLE IF NOT EXISTS broadcasts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  subject text NOT NULL,
  body text NOT NULL,
  status text NOT NULL DEFAULT 'draft',
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  sent_at timestamptz,
  recipient_count integer NOT NULL DEFAULT 0,
  sent_count integer NOT NULL DEFAULT 0,
  failed_count integer NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS broadcasts_created_idx ON broadcasts(created_at);
CREATE TABLE IF NOT EXISTS broadcast_recipients (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  broadcast_id uuid NOT NULL,
  signup_id uuid NOT NULL,
  email text NOT NULL,
  sent_at timestamptz,
  error text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS broadcast_recipients_pair_uidx ON broadcast_recipients(broadcast_id, signup_id);
CREATE INDEX IF NOT EXISTS broadcast_recipients_broadcast_idx ON broadcast_recipients(broadcast_id);
CREATE TABLE IF NOT EXISTS billing_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source text NOT NULL,
  event_id text NOT NULL,
  kind text NOT NULL,
  user_id text,
  amount_cents integer NOT NULL DEFAULT 0,
  mrr_delta_cents integer NOT NULL DEFAULT 0,
  effective_at timestamptz NOT NULL,
  detail jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS billing_events_source_event_uidx ON billing_events(source, event_id);
CREATE INDEX IF NOT EXISTS billing_events_effective_idx ON billing_events(effective_at);
CREATE INDEX IF NOT EXISTS billing_events_user_effective_idx ON billing_events(user_id, effective_at);
CREATE INDEX IF NOT EXISTS billing_events_kind_effective_idx ON billing_events(kind, effective_at);
CREATE TABLE IF NOT EXISTS infra_costs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider text NOT NULL,
  period_month timestamptz NOT NULL,
  amount_cents integer NOT NULL,
  note text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS infra_costs_provider_month_uidx ON infra_costs(provider, period_month);
CREATE INDEX IF NOT EXISTS infra_costs_month_idx ON infra_costs(period_month);
CREATE TABLE IF NOT EXISTS gate_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id text NOT NULL,
  feature text NOT NULL,
  plan text NOT NULL,
  context jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS gate_events_feature_created_idx ON gate_events(feature, created_at);
CREATE INDEX IF NOT EXISTS gate_events_user_created_idx ON gate_events(user_id, created_at);
CREATE INDEX IF NOT EXISTS admin_audit_log_action_idx ON admin_audit_log(action, created_at);
CREATE TABLE IF NOT EXISTS app_surface_flags (
  surface_key text PRIMARY KEY,
  hidden_at timestamptz NOT NULL DEFAULT now(),
  hidden_by text NOT NULL
);
CREATE TABLE IF NOT EXISTS constellation_settings (
  id integer PRIMARY KEY DEFAULT 1,
  filter_enabled boolean NOT NULL DEFAULT true,
  min_inbound_messages integer NOT NULL DEFAULT 3,
  min_outbound_messages integer NOT NULL DEFAULT 3,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by text,
  CONSTRAINT constellation_settings_single_row CHECK (id = 1)
);
CREATE TABLE IF NOT EXISTS startup_expenses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  category text NOT NULL,
  amount_usd real NOT NULL,
  incurred_at timestamptz NOT NULL,
  note text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS cash_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  as_of timestamptz NOT NULL,
  balance_usd real NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS acquisition_spend (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  channel text NOT NULL,
  amount_usd real NOT NULL,
  period_start timestamptz NOT NULL,
  period_end timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS fundraising_rounds (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  target_usd real NOT NULL,
  status text NOT NULL DEFAULT 'open',
  closed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS fundraising_investors (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  round_id uuid NOT NULL REFERENCES fundraising_rounds(id),
  name text NOT NULL,
  amount_usd real NOT NULL,
  committed_at timestamptz NOT NULL,
  received_at timestamptz,
  note text
);
CREATE TABLE IF NOT EXISTS non_dilutive_funding (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source text NOT NULL,
  kind text NOT NULL,
  form text NOT NULL DEFAULT 'cash',
  repayable boolean NOT NULL DEFAULT false,
  repaid_usd real NOT NULL DEFAULT 0,
  amount_usd real NOT NULL,
  awarded_at timestamptz NOT NULL,
  received_at timestamptz,
  expires_at timestamptz,
  note text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id text NOT NULL,
  title text NOT NULL,
  starts_at timestamptz,
  ends_at timestamptz,
  timezone text,
  venue text,
  city text,
  url text,
  role text NOT NULL DEFAULT 'attended',
  source text NOT NULL DEFAULT 'manual',
  provider text,
  provider_event_id text,
  description text,
  cover_image_url text,
  cover_source_url text,
  theme_color text,
  theme_source text,
  theme_locked integer NOT NULL DEFAULT 0,
  attendee_count integer,
  notes text,
  enriched_at timestamptz,
  enrich_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS event_attendees (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id uuid NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  user_id text NOT NULL,
  full_name text,
  email text,
  company text,
  title text,
  linkedin_url text,
  x_handle text,
  phone text,
  attendee_role text,
  source text NOT NULL DEFAULT 'paste',
  external_ref text,
  spoke_to integer NOT NULL DEFAULT 0,
  contact_id uuid REFERENCES contacts(id) ON DELETE SET NULL,
  converted_at timestamptz,
  identity_key text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS event_provider_connections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id text NOT NULL,
  provider text NOT NULL,
  auth_kind text NOT NULL,
  label text,
  account_ref text,
  api_key_encrypted text,
  access_token_encrypted text,
  refresh_token_encrypted text,
  token_expires_at timestamptz,
  scopes text,
  status text NOT NULL DEFAULT 'active',
  last_synced_at timestamptz,
  sync_cursor jsonb,
  next_sync_at timestamptz,
  sync_status text,
  sync_started_at timestamptz,
  sync_error text,
  sync_failures integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
`;

// NOTE: the admin-console indexes are deliberately NOT in the DDL template above. Several of
// them cover columns (`user_settings.email`, `last_active_at`) that the template's CREATE
// TABLE does not declare — they only exist after the column migrations below run, so an
// index here fails the whole bootstrap on a fresh database. They live in
// ADMIN_V2_STATEMENTS instead, which both engines run after their column pass.

/**
 * Schema version.
 *
 * **Bump this whenever you add DDL** — to the `DDL` template, `SCALE_DDL`, `alters`,
 * `ADMIN_V2_STATEMENTS`, or the `ensureColumn` calls in `migratePglite`. A database whose
 * recorded version already matches skips the entire sweep, so new DDL that arrives without
 * a bump never runs on an instance that has already migrated.
 *
 * The gate exists because `getDb()` replayed every one of those statements on the cold
 * start of each serverless instance — ~165 sequential HTTPS round trips on `neon-http`, all
 * of them no-ops after the first deploy, blocking the first request. One SELECT confirms a
 * warm schema instead. A database with no version row (anything migrated before this
 * shipped) reads as out of date and takes the full pass once.
 *
 * v17 = note processing tables (note_batches, interaction_mentions, action_items,
 * contact_briefs) plus reminder/interaction provenance columns.
 * v18 = legacy action-item backfill guards on jsonb_typeof(action_items) = 'array'.
 * v19 = YC-mode read indexes (startup_expenses, cash_snapshots, acquisition_spend,
 * fundraising_rounds/investors) plus the admin audit-log lookup index.
 * v20 = the Money section's cash ledger and cost tables.
 * v21 = the merge of the two: a database stamped 19 is missing v20's tables and one
 * stamped 20 is missing v19's indexes, so neither number can stand for both.
 * v22 = non_dilutive_funding, plus fundraising_investors.received_at.
 * v23 = contact_embeddings.content_hash (hybrid contact search).
 * v24 = ops_alert_state (the production-readiness ops sweep's alert ledger).
 * v25 = imports.stall_resumes (the process-stalled cron's give-up counter).
 * v26 = rate_limit_buckets (DB-backed rate limiting for chat, capture, and avatar resolve).
 * v27 = contact_profiles + contact_experiences (LinkedIn experience extraction).
 * v28 = the constellation filter: constellation_settings, contacts.constellation_pin,
 * interactions.direction, and the partial index that keeps the eligibility aggregate an
 * index-only scan once `direction` joins its predicate.
 * v29 = feedback triage columns (area, category, status, status_changed_at/by,
 * resolution_note) plus the feedback_screenshots child table.
 *
 * (Three branches have now collided on a number here, and each time the one that merged
 * second had to move: the feedback work called itself 27, then 28, and lands as 29. The
 * rule is the one v21 records — a database stamped N by the branch that merged first has
 * none of the second branch's DDL, so re-using N would skip the sweep on every instance
 * that had already migrated, and the columns would simply never appear.)
 *
 * v30 = continuous provider sync: sync_cursor/next_sync_at/sync_status/sync_started_at/
 * sync_error/sync_failures on both connection tables, plus their partial due indexes.
 * v31 = the connector platform: api_keys, api_idempotency_keys, webhook_endpoints,
 * outbound_webhook_deliveries.
 * v32 = the events feature: events, event_attendees, event_provider_connections.
 *
 * (Make that four. This branch has been renumbered 27/28 -> 28/29 -> 29/30 -> 30/31 as the
 * LinkedIn, constellation and feedback branches each landed first. If this one collides
 * too, renumber to 33 and regenerate scripts/schema-ddl.lock.json rather than reusing 32.)
 */
export const SCHEMA_VERSION = 32;

/**
 * Everything the contacts surface needs to stay constant-time as a network grows past a
 * few thousand people. Kept apart from `DDL` because these are all `ALTER`/`CREATE INDEX`
 * statements: `CREATE TABLE IF NOT EXISTS` never adds a column to a table that already
 * exists, so putting them in the table body above would silently skip every existing
 * database. One list, run by both drivers, so Neon and PGlite cannot drift.
 *
 * Ordering matters: generated columns before the indexes that read them.
 */
export const SCALE_DDL: string[] = [
  // --- Generated columns -----------------------------------------------------------
  //
  // Last-name sort key. This is the keyset-pagination ordering column, and it must agree
  // exactly with what the UI would have computed — `lastNameSortKey` in
  // `src/actions/contacts.ts` and `lastNameOf` in `contacts-list.tsx` both derived this in
  // JavaScript, and a page boundary that disagrees with the sort silently drops or repeats
  // contacts. Both of those are deleted in favour of this column.
  `ALTER TABLE contacts ADD COLUMN IF NOT EXISTS sort_key text
     GENERATED ALWAYS AS (
       lower(coalesce(nullif(trim(last_name), ''), split_part(trim(full_name), ' ', -1)))
     ) STORED`,

  // Normalized LinkedIn slug — the identity two accounts are matched on, so mutual-contact
  // lookup can use an index instead of a leading-wildcard ILIKE across every user's contacts.
  //
  // Dropped first because a generated column's expression cannot be altered in place, and an
  // earlier revision of this stopped at the first `/` only. That left the query string on the
  // slug, so the same person saved as `/in/ada` by one account and `/in/ada?trk=...` by
  // another would not match. Cheap to redo — the column is derived, so Postgres refills it,
  // and this only runs when `SCHEMA_VERSION` changes.
  //
  // Must stay in step with `extractLinkedinSlug` in `src/actions/contacts.ts`, whose regex
  // this reproduces: everything after `/in/` up to a `/`, `?` or `#`.
  `ALTER TABLE contacts DROP COLUMN IF EXISTS linkedin_slug`,
  `ALTER TABLE contacts ADD COLUMN IF NOT EXISTS linkedin_slug text
     GENERATED ALWAYS AS (
       lower(nullif(
         split_part(split_part(split_part(split_part(coalesce(linkedin_url, ''), '/in/', 2), '?', 1), '#', 1), '/', 1),
         ''
       ))
     ) STORED`,

  // Weighted search vector. The weight classes mirror FIELD_WEIGHTS in
  // `src/lib/keyword-search.ts`: name is an A, employer/school/role a B, the contact
  // details a C, and free text a D. 'simple' rather than 'english' on purpose — names and
  // companies are not English words and stemming them ("Manning" -> "Man") loses matches.
  //
  // Tags are not here: they live in their own table and a generated column may only read
  // its own row. Tag matches are an EXISTS subquery in the search predicate instead.
  `ALTER TABLE contacts ADD COLUMN IF NOT EXISTS search_tsv tsvector
     GENERATED ALWAYS AS (
       setweight(to_tsvector('simple', coalesce(full_name, '') || ' ' || coalesce(preferred_name, '')), 'A') ||
       setweight(to_tsvector('simple', coalesce(company, '') || ' ' || coalesce(school, '') || ' ' || coalesce(title, '')), 'B') ||
       setweight(to_tsvector('simple', coalesce(email, '') || ' ' || coalesce(location, '') || ' ' || coalesce(how_met, '') || ' ' || coalesce(met_context, '') || ' ' || coalesce(industry, '')), 'C') ||
       setweight(to_tsvector('simple', coalesce(ai_summary, '') || ' ' || coalesce(notes, '')), 'D')
     ) STORED`,

  // --- Materialized closeness ------------------------------------------------------
  //
  // Closeness is cohort-relative: a contact's ring is its position in the distribution
  // formed by the whole network, which is why every surface used to scan every contact to
  // render any of them. These columns hold the already-applied result so a page of 50 can
  // be served without the other 4,950. See `src/lib/closeness-materialize.ts`.
  `ALTER TABLE contacts ADD COLUMN IF NOT EXISTS closeness_raw real`,
  `ALTER TABLE contacts ADD COLUMN IF NOT EXISTS closeness integer`,
  `ALTER TABLE contacts ADD COLUMN IF NOT EXISTS closeness_tier text`,
  `ALTER TABLE contacts ADD COLUMN IF NOT EXISTS orbit_score integer`,
  // Evidence and prior are what `selectTriageCandidates` ranks on; it read them off the
  // in-memory breakdown, so they have to survive the move to storage.
  `ALTER TABLE contacts ADD COLUMN IF NOT EXISTS closeness_evidence real`,
  `ALTER TABLE contacts ADD COLUMN IF NOT EXISTS closeness_prior real`,
  `ALTER TABLE contacts ADD COLUMN IF NOT EXISTS closeness_computed_at timestamptz`,
  // The full `ClosenessBreakdown`, including the component scores (strength, recency,
  // cadence, goal relevance) that the contact-detail explanation renders. The scalar
  // columns above are what the list page reads and sorts on; this is what the surfaces
  // that want the whole picture read, so neither has to recompute the cohort.
  `ALTER TABLE contacts ADD COLUMN IF NOT EXISTS closeness_breakdown jsonb`,

  // The per-user distribution the scores above were applied against. `snapshot` holds a
  // fixed-size quantile sketch rather than the raw sorted array, so this row stays the
  // same size whether the user has 50 contacts or 50,000. `dirty_at` is set by writes and
  // drained by recalibration.
  `CREATE TABLE IF NOT EXISTS closeness_cohorts (
     user_id text PRIMARY KEY,
     snapshot jsonb NOT NULL DEFAULT '{}',
     contact_count integer NOT NULL DEFAULT 0,
     computed_at timestamptz NOT NULL DEFAULT now(),
     dirty_at timestamptz
   )`,

  // --- Indexes ---------------------------------------------------------------------
  //
  // Serves the default keyset page. The trailing full_name and id break ties so the cursor
  // is total-ordered — without them two people sorting equal can straddle a page boundary.
  `CREATE INDEX IF NOT EXISTS contacts_user_sort_idx ON contacts(user_id, sort_key, full_name, id)`,
  `CREATE INDEX IF NOT EXISTS contacts_user_updated_idx ON contacts(user_id, updated_at DESC)`,
  // Column directions match `orderFor` in `src/actions/contacts.ts` exactly, including the
  // descending id. The cursor is a row-value comparison, which needs every element ordered
  // the same way, so the index has to be declared that way to serve it.
  `CREATE INDEX IF NOT EXISTS contacts_user_closeness_idx ON contacts(user_id, closeness DESC, id DESC)`,
  `CREATE INDEX IF NOT EXISTS contacts_user_recent_idx ON contacts(user_id, updated_at DESC, id DESC)`,
  `CREATE INDEX IF NOT EXISTS contacts_search_gin ON contacts USING gin(search_tsv)`,
  `CREATE INDEX IF NOT EXISTS contacts_slug_idx ON contacts(linkedin_slug) WHERE linkedin_slug IS NOT NULL`,
  `CREATE INDEX IF NOT EXISTS contacts_user_email_idx ON contacts(user_id, email) WHERE email IS NOT NULL`,
  // Both of these back a foreign key that had no index: deleting a company or a tag was a
  // full scan of the referencing table.
  `CREATE INDEX IF NOT EXISTS contacts_company_id_idx ON contacts(company_id)`,
  `CREATE INDEX IF NOT EXISTS contact_tags_tag_idx ON contact_tags(tag_id)`,
  // `(user_id, contact_id, ...)` cannot serve a plain user+date ordering, so the knowledge
  // base and outreach refresh had no usable index for their scans.
  `CREATE INDEX IF NOT EXISTS interactions_user_date_idx ON interactions(user_id, interaction_date DESC)`,
  `CREATE INDEX IF NOT EXISTS embeddings_user_src_idx ON contact_embeddings(user_id, source_type, contact_id)`,
  // Reminders had `(user_id, status)`, `(user_id, due_date)` and `(user_id, list_id)` but
  // nothing on contact_id, while eight hot paths filter by it — the contact detail page,
  // every reminder write, calendar sync, and the import engine's per-chunk `inArray` dedupe.
  // Each of those was a per-user index scan plus a filter instead of a point lookup.
  `CREATE INDEX IF NOT EXISTS reminders_user_contact_idx ON reminders(user_id, contact_id)`,
  // Company/school concentration in `src/lib/closeness-materialize.ts` counts with
  // `lower(trim(company)) = $1`. A b-tree on the bare column cannot serve that — Postgres
  // could only use the user_id prefix and then filter every one of that user's entries —
  // so these are expression indexes matching the predicate exactly. `lower` and `btrim`
  // are both immutable, which is what makes them indexable. This runs on every contact
  // create, update and logInteraction, so it is not a cold path.
  `CREATE INDEX IF NOT EXISTS contacts_user_company_norm_idx ON contacts(user_id, lower(trim(company)))`,
  `CREATE INDEX IF NOT EXISTS contacts_user_school_norm_idx ON contacts(user_id, lower(trim(school)))`,
  // Lets upsertContactEmbedding and rebuildContactEmbeddingsBatch skip the embedding API
  // call entirely when a row's source content hasn't changed since it was last embedded.
  `ALTER TABLE contact_embeddings ADD COLUMN IF NOT EXISTS content_hash text`,

  // --- YC-mode admin console --------------------------------------------------------
  //
  // Every one of these tables shipped with `CREATE TABLE IF NOT EXISTS` above and no
  // index beyond its primary key. Small at launch, but each row is a hand-entered log
  // entry an operator adds over the life of the company, and every YC-mode page load
  // filters or sorts on exactly the column indexed here — see the matching Drizzle
  // `index()` call on each table in `schema.ts` for which query it serves.
  `CREATE INDEX IF NOT EXISTS startup_expenses_incurred_idx ON startup_expenses(incurred_at)`,
  `CREATE INDEX IF NOT EXISTS cash_snapshots_as_of_idx ON cash_snapshots(as_of)`,
  `CREATE INDEX IF NOT EXISTS acquisition_spend_created_idx ON acquisition_spend(created_at)`,
  `CREATE INDEX IF NOT EXISTS fundraising_rounds_created_idx ON fundraising_rounds(created_at)`,
  `CREATE INDEX IF NOT EXISTS fundraising_investors_round_idx ON fundraising_investors(round_id)`,
  `CREATE INDEX IF NOT EXISTS fundraising_investors_committed_idx ON fundraising_investors(committed_at)`,
  `CREATE INDEX IF NOT EXISTS non_dilutive_funding_awarded_idx ON non_dilutive_funding(awarded_at)`,

  // The one admin_audit_log query that leads with admin_user_id (`recordAccountView`'s
  // throttle check) had no supporting index — its three existing indexes lead with
  // created_at, target_user_id, and action respectively.
  `CREATE INDEX IF NOT EXISTS admin_audit_log_admin_target_idx ON admin_audit_log(admin_user_id, target_user_id, created_at)`,

  // Legacy action items → rows. Idempotent through the unique (user_id, item_hash) index —
  // which is why this lives here rather than in `ADMIN_V2_STATEMENTS`: this runs via
  // `applyScaleSchema`, AFTER `applySchema` has created every index, so the ON CONFLICT
  // target the INSERT depends on is guaranteed to exist. `ADMIN_V2_STATEMENTS` is spread
  // into the `alters` pass, which runs BEFORE indexes — an insert placed there would fail
  // on any database (fresh or upgrading) that does not already have this index.
  // The hash formula MUST equal actionItemHash() in src/lib/action-items.ts.
  `INSERT INTO action_items (user_id, contact_id, interaction_id, text, position, item_hash)
   SELECT i.user_id, i.contact_id, i.id, a.value, a.ordinality - 1,
          encode(sha256(convert_to(i.id::text || '|' || lower(btrim(a.value)), 'UTF8')), 'hex')
   FROM interactions i, jsonb_array_elements_text(COALESCE(i.action_items, '[]'::jsonb)) WITH ORDINALITY a
   WHERE jsonb_typeof(i.action_items) = 'array' AND btrim(a.value) <> ''
   ON CONFLICT (user_id, item_hash) DO NOTHING`,

  // --- LinkedIn profiles -----------------------------------------------------------
  //
  // The unique index is what makes a profile row per contact an invariant rather than a
  // convention: `saveContactProfile` upserts on it.
  `CREATE UNIQUE INDEX IF NOT EXISTS contact_profiles_contact_uidx
     ON contact_profiles(user_id, contact_id)`,
  `CREATE INDEX IF NOT EXISTS contact_experiences_contact_idx
     ON contact_experiences(user_id, contact_id, sort_index)`,
  // "Who has ever worked at X". Read by experienceArm in src/lib/hybrid-search.ts -- but
  // for its LEADING COLUMN ONLY: EXPLAIN over 60k rows across 120 tenants shows a bitmap
  // index scan whose Index Cond is user_id alone, scoping the scan to one tenant, after
  // which the organization patterns are applied as a post-index filter. The arm ORs
  // word-boundary patterns (leading wildcard, unindexable) with its exact/prefix tiers,
  // and that disjunction is what stops the second column from being used.
  //
  // It is NOT read by experienceExists in filterCondition, despite an earlier comment here
  // saying so: Postgres hashes that correlated subquery into a SubPlan and seq-scans
  // contact_experiences across every tenant (60000 rows removed by filter), losing even
  // the user_id scoping. Worth revisiting if the filter path ever gets hot.
  //
  // Keep prose in this array free of backticks: the schema-ddl guard's fingerprint treats
  // every backtick pair between these brackets as a DDL statement.
  `CREATE INDEX IF NOT EXISTS contact_experiences_org_idx
     ON contact_experiences(user_id, organization_normalized)`,
];

/** Runs one SQL statement on whichever driver is active. */
export type StatementRunner = (statement: string) => Promise<unknown>;

/**
 * Runs a list of idempotent DDL statements, tolerating the "it was already there" failures
 * that `IF NOT EXISTS` cannot express (adding a constraint, mostly) while still surfacing
 * anything genuinely wrong instead of swallowing it.
 */
/** "It was already there" — the only failures an idempotent sweep may ignore. */
const BENIGN_DDL_FAILURE = /already exists|duplicate key|duplicate object/i;

export type SchemaFailure = { statement: string; message: string };

/**
 * Runs a list of idempotent DDL statements. With a `failed` collector every real failure
 * is recorded for the caller to act on (the build-time migration refuses to deploy on any);
 * without one it is logged, which is all a runtime cold start can do.
 */
async function runStatements(
  run: StatementRunner,
  statements: string[],
  label: string,
  failed?: SchemaFailure[]
) {
  for (const statement of statements) {
    try {
      await run(statement);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (BENIGN_DDL_FAILURE.test(message)) continue;
      const head = statement.trim().split("\n")[0].slice(0, 140);
      if (failed) failed.push({ statement: head, message });
      else console.error(`[db] ${label} failed: ${head}\n`, message);
    }
  }
}

/**
 * The scale schema, applied identically to Neon and PGlite.
 *
 * The two pieces that cannot just live in `SCALE_DDL` are here: `pg_trgm` has to exist
 * before an index can use `gin_trgm_ops`, and the `contact_tags` uniqueness can only be
 * added once the duplicate pairs already in the table are gone.
 */
export async function applyScaleSchema(run: StatementRunner, failed?: SchemaFailure[]) {
  await runStatements(run, SCALE_DDL, "scale DDL", failed);

  // Fuzzy name matching. Available on Neon as an extension and bundled with PGlite (see
  // `ensureReady`), so local search finally behaves like production — unlike pgvector,
  // whose PGlite build ships only in a separate package pinned to a newer PGlite than
  // this project uses (see `migratePgvector`). If it is unavailable the index is skipped
  // and search still works through `search_tsv`; only typo tolerance is lost.
  try {
    await run(`CREATE EXTENSION IF NOT EXISTS pg_trgm`);
    // The predicates in searchCondition and the hybrid search arms compare
    // lower(column), so the index must be on the identical expression or the
    // planner ignores it. The old contacts_name_trgm on the raw columns was
    // never usable; drop it on the way through.
    await run(`DROP INDEX IF EXISTS contacts_name_trgm`);
    await run(
      `CREATE INDEX IF NOT EXISTS contacts_name_trgm
       ON contacts USING gin(lower(full_name) gin_trgm_ops, lower(coalesce(company, '')) gin_trgm_ops)`
    );
    globalForDb.orbitTrigram = true;
  } catch {
    globalForDb.orbitTrigram = false;
  }

  // `contact_tags` has a surrogate primary key and no natural uniqueness, so a double write
  // could leave two rows for the same pair — `syncTags` deletes-then-inserts specifically to
  // work around that. Drop the existing duplicates before claiming the constraint, or the
  // CREATE fails and the workaround has to stay forever.
  try {
    await run(
      `DELETE FROM contact_tags a
       USING contact_tags b
       WHERE a.ctid > b.ctid
         AND a.contact_id = b.contact_id
         AND a.tag_id = b.tag_id`
    );
    await run(
      `CREATE UNIQUE INDEX IF NOT EXISTS contact_tags_pair_uidx
       ON contact_tags(contact_id, tag_id)`
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (!/already exists/i.test(message)) {
      console.error("[db] contact_tags dedupe failed\n", message);
    }
  }
}

/**
 * Whether the recorded schema version already matches this build.
 *
 * One SELECT standing in for the whole DDL sweep. Anything unexpected (no table yet, a
 * fresh database, a permissions problem) answers "no" and the caller does the full pass —
 * being wrong here costs a slow boot, never a wrong schema.
 */
export async function schemaIsCurrent(run: StatementRunner): Promise<boolean> {
  try {
    await run(
      `CREATE TABLE IF NOT EXISTS schema_migrations (
         id integer PRIMARY KEY DEFAULT 1,
         version integer NOT NULL,
         applied_at timestamptz NOT NULL DEFAULT now(),
         CONSTRAINT schema_migrations_single_row CHECK (id = 1)
       )`
    );
    const result = await run(
      `SELECT version FROM schema_migrations WHERE id = 1`
    );
    const rows = rowsOf<{ version: number | string }>(result);
    return Number(rows[0]?.version) === SCHEMA_VERSION;
  } catch {
    return false;
  }
}

/**
 * Establishes which optional extensions this database actually has.
 *
 * `isPgvectorAvailable()` reads module state that the migration path normally sets as a
 * side effect. A boot that skips the migration still has to know, or every search silently
 * takes the in-JS cosine fallback.
 */
async function detectExtensions(run: StatementRunner) {
  try {
    const result = await run(
      `SELECT extname FROM pg_extension WHERE extname IN ('vector', 'pg_trgm')`
    );
    const names = new Set(
      rowsOf<{ extname: string }>(result).map((r) => r.extname)
    );
    globalForDb.orbitPgvector = names.has("vector");
    globalForDb.orbitTrigram = names.has("pg_trgm");
  } catch {
    globalForDb.orbitPgvector = false;
    globalForDb.orbitTrigram = false;
  }
}

export async function recordSchemaVersion(run: StatementRunner) {
  try {
    await run(
      `INSERT INTO schema_migrations (id, version, applied_at)
       VALUES (1, ${SCHEMA_VERSION}, now())
       ON CONFLICT (id) DO UPDATE
         SET version = EXCLUDED.version, applied_at = EXCLUDED.applied_at`
    );
  } catch (err) {
    // A boot that cannot record its version just re-runs the idempotent sweep next time.
    console.error("[db] could not record schema version\n", err);
  }
}

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

async function migratePglite(client: PGlite): Promise<SchemaFailure[]> {
  const failed: SchemaFailure[] = [];
  await applySchema((statement) => client.query(statement), failed);

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
  await ensureColumn(client, "interactions", "direction", "text");
  await ensureColumn(client, "contacts", "constellation_pin", "text");
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
  await ensureColumn(client, "user_settings", "yc_mode_enabled", "boolean DEFAULT false");
  await ensureColumn(client, "user_settings", "estimated_monthly_churn_pct", "real");
  // Deliberately not backfilled from `committed_at` — see the column's comment in schema.ts.
  await ensureColumn(client, "fundraising_investors", "received_at", "timestamptz");
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
  await ensureColumn(
    client,
    "user_settings",
    "recruiter_sharing",
    "integer NOT NULL DEFAULT 0"
  );
  await ensureColumn(
    client,
    "user_recruiter_links",
    "shared_to_pool",
    "integer NOT NULL DEFAULT 1"
  );
  await ensureColumn(client, "user_recruiter_links", "ai_summary", "text");
  await ensureColumn(
    client,
    "user_recruiter_links",
    "companies_mentioned",
    "jsonb DEFAULT '[]'"
  );
  await ensureColumn(
    client,
    "user_recruiter_links",
    "roles_discussed",
    "jsonb DEFAULT '[]'"
  );
  await ensureColumn(client, "user_recruiter_links", "first_email_at", "timestamptz");
  await ensureColumn(client, "user_recruiter_links", "last_email_at", "timestamptz");
  await ensureColumn(
    client,
    "user_recruiter_links",
    "email_count",
    "integer NOT NULL DEFAULT 0"
  );
  await ensureColumn(client, "user_recruiter_links", "gmail_thread_id", "text");

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
  await ensureColumn(client, "user_settings", "subscription_monthly_cents", "integer");
  await ensureColumn(client, "user_settings", "subscription_interval", "text");
  await ensureColumn(client, "user_settings", "comped_note", "text");
  await ensureColumn(client, "user_settings", "comped_at", "timestamptz");
  await ensureColumn(client, "user_settings", "comped_by", "text");
  await ensureColumn(client, "user_settings", "last_active_at", "timestamptz");

  // Clerk identity mirror. Columns rather than a new table, so they ride along on every
  // query that already reads `user_settings` — the admin roster gets a display name and an
  // avatar for zero extra round trips.
  await ensureColumn(client, "user_settings", "first_name", "text");
  await ensureColumn(client, "user_settings", "last_name", "text");
  await ensureColumn(client, "user_settings", "profile_image_url", "text");

  // Acquisition attribution. Columns rather than a table for the same reason as the
  // identity mirror: they ride along on every query that already reads `user_settings`.
  await ensureColumn(client, "user_settings", "signup_referrer", "text");
  await ensureColumn(client, "user_settings", "signup_utm_source", "text");
  await ensureColumn(client, "user_settings", "signup_utm_medium", "text");
  await ensureColumn(client, "user_settings", "signup_utm_campaign", "text");
  await ensureColumn(client, "user_settings", "signup_landing_path", "text");
  await ensureColumn(client, "user_settings", "signup_attributed_at", "timestamptz");

  // Embedding staleness: imports flag contacts here instead of embedding inline, and a
  // separate backfill drains them. The dedupe is safe to re-run — it only ever deletes rows
  // that lose the (user_id, contact_id, source_type, source_id) tiebreak, and once the
  // unique index exists no more duplicates can be created for it to find.
  //
  // The key includes `source_id` because that is the real uniqueness contract:
  // `upsertContactEmbedding` (src/lib/search.ts) keys its existence check on all four
  // columns, and calendar-sync writes one `"meeting"` row per meeting with a distinct
  // `source_id`. A three-column key would both delete every meeting embedding but the
  // newest and make every subsequent meeting write raise a unique violation that
  // `upsertContactEmbedding`'s catch swallows. `source_id` is nullable and Postgres
  // indexes NULLs as distinct by default, so rows with a null `source_id` are simply
  // unconstrained — which matches the writer, since `upsertContactEmbedding` skips its
  // existence check entirely when no `source_id` is supplied.
  await ensureColumn(client, "contacts", "embedding_stale_at", "timestamptz");

  try {
    await client.exec(
      `CREATE INDEX IF NOT EXISTS contacts_embedding_stale_idx
       ON contacts(user_id) WHERE embedding_stale_at IS NOT NULL`
    );
  } catch {
    // Index may already exist
  }

  try {
    await client.exec(`
      DELETE FROM contact_embeddings a
      USING contact_embeddings b
      WHERE a.user_id = b.user_id
        AND a.contact_id = b.contact_id
        AND a.source_type = b.source_type
        AND a.source_id = b.source_id
        AND (a.created_at < b.created_at OR (a.created_at = b.created_at AND a.id < b.id))
    `);
  } catch {
    // Nothing to dedupe
  }

  // An earlier revision of this migration created the same-named index on only three
  // columns. Drop it by name before creating the correct one, or a database that already
  // migrated keeps the over-strict key forever. Both statements are no-ops once the
  // four-column index is in place.
  try {
    await client.exec(`DROP INDEX IF EXISTS embeddings_user_contact_source_uidx`);
  } catch {
    // Index may not exist
  }

  try {
    await client.exec(
      `CREATE UNIQUE INDEX IF NOT EXISTS embeddings_user_contact_source_id_uidx
       ON contact_embeddings(user_id, contact_id, source_type, source_id)`
    );
  } catch {
    // Index may already exist
  }

  // `query` rather than `exec`: it returns `{ rows }`, which `rowsOf` understands, so the
  // schema-version SELECT reads the same on both drivers. Every statement here is a single
  // command, which is what `query` requires.
  await applyScaleSchema((statement) => client.query(statement), failed);

  // Admin console v2: operator suspension, plus the indexes the cross-user roster/trend
  // queries need. Same reasoning as the block above — the DDL template only helps a
  // database that does not have `user_settings` yet.
  await ensureColumn(client, "user_settings", "suspended_at", "timestamptz");
  await ensureColumn(client, "user_settings", "suspended_reason", "text");
  await ensureColumn(client, "user_settings", "suspended_by", "text");

  // Same reasoning: a local database built by the version that first added
  // `interest_list_signups` has the table but neither of these columns.
  await ensureColumn(client, "interest_list_signups", "welcome_planet", "text");
  await ensureColumn(client, "interest_list_signups", "follow_up_sent_at", "timestamptz");

  // And the same for the feedback triage columns: a local database built before the
  // feedback console existed has the table but none of them.
  await ensureColumn(client, "feedback", "area", "text");
  await ensureColumn(client, "feedback", "category", "text");
  await ensureColumn(client, "feedback", "status", "text NOT NULL DEFAULT 'new'");
  await ensureColumn(client, "feedback", "status_changed_at", "timestamptz");
  await ensureColumn(client, "feedback", "status_changed_by", "text");
  await ensureColumn(client, "feedback", "resolution_note", "text");

  // Schema v17 note-processing provenance columns (interactions/reminders note_batch_id
  // and friends), and admin console v2's own indexes, are covered by the shared `alters`
  // list above via `applySchema` — not here. `ADMIN_V2_STATEMENTS` is spread into that
  // list, so running it again here would just repeat it.
  return failed;
}

/**
 * Shared by both engines so the two migration paths cannot drift.
 *
 * `imports` had no `user_id` index at all, which made the admin roster fan-out a sequential
 * scan; the rest are `(user_id, created_at)` composites for the time-bucketed trend queries.
 * The `usage_events` one is partial — failures are a small fraction of the table, and the
 * error-triage screen only ever reads that slice.
 */
const ADMIN_V2_STATEMENTS = [
  `CREATE INDEX IF NOT EXISTS admin_audit_log_action_idx ON admin_audit_log(action, created_at)`,
  `CREATE INDEX IF NOT EXISTS imports_user_created_idx ON imports(user_id, created_at)`,
  `CREATE INDEX IF NOT EXISTS imports_status_updated_idx ON imports(status, updated_at)`,
  `CREATE INDEX IF NOT EXISTS contacts_user_created_idx ON contacts(user_id, created_at)`,
  `CREATE INDEX IF NOT EXISTS interactions_user_created_idx ON interactions(user_id, created_at)`,
  `CREATE INDEX IF NOT EXISTS chat_messages_user_created_idx ON chat_messages(user_id, created_at)`,
  `CREATE INDEX IF NOT EXISTS user_settings_created_idx ON user_settings(created_at)`,
  `CREATE INDEX IF NOT EXISTS user_settings_email_idx ON user_settings(email)`,
  `CREATE INDEX IF NOT EXISTS user_settings_last_active_idx ON user_settings(last_active_at)`,
  `CREATE INDEX IF NOT EXISTS usage_events_failures_idx ON usage_events(user_id, created_at) WHERE success = 0`,
  `CREATE UNIQUE INDEX IF NOT EXISTS reminders_user_item_hash_uidx ON reminders(user_id, item_hash)`,
  `CREATE INDEX IF NOT EXISTS reminders_note_batch_idx ON reminders(note_batch_id)`,
  `CREATE INDEX IF NOT EXISTS interactions_note_batch_idx ON interactions(note_batch_id)`,
];

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

export function isTrigramAvailable() {
  return Boolean(globalForDb.orbitTrigram);
}

/**
 * The raw Neon client, or null on the PGlite path.
 *
 * Only for callers that genuinely need to bypass Drizzle — the pgvector backfill writes a
 * `::vector` literal, which has no Drizzle column to write through because
 * `embedding_vector` is created at runtime and is not in `schema.ts`.
 */
export function neonClient() {
  return globalForDb.orbitNeonSql ?? null;
}

/**
 * Copies JSONB embeddings into the pgvector column for rows written before it existed.
 *
 * Deliberately NOT on the boot path any more. Normally one round trip per run (a single
 * batched `UPDATE ... FROM (VALUES ...)`) rather than one per row, so it can be called more
 * aggressively than before if needed — but the daily cron cadence is left alone here. If the
 * batched statement fails (e.g. one malformed/wrong-dimension embedding in the window), this
 * falls back to per-row updates so a single bad row can't wedge the whole window: the SELECT
 * has no cursor, so a permanently-failing batch would otherwise re-select and re-fail the
 * same rows on every future cron run. Bad rows are logged and skipped; everything else in the
 * window still drains. Returns the number of rows actually copied. Until a row is copied,
 * search just falls back for that row.
 */
export async function backfillEmbeddingVectors(
  sql: ReturnType<typeof neon>,
  limit = 500
) {
  const result = await sql.query(
    `SELECT id, embedding
     FROM contact_embeddings
     WHERE embedding_vector IS NULL
       AND embedding IS NOT NULL
     LIMIT ${Number(limit) || 500}`
  );
  const rows = (Array.isArray(result) ? result : []) as Array<{
    id: string;
    embedding: number[];
  }>;

  const valid = rows.filter(
    (row) => Array.isArray(row.embedding) && row.embedding.length > 0
  );
  if (valid.length === 0) return 0;

  const params: unknown[] = [];
  const tuples = valid
    .map((row, i) => {
      params.push(row.id, formatVectorLiteral(row.embedding));
      return `($${i * 2 + 1}::uuid, $${i * 2 + 2}::vector)`;
    })
    .join(", ");
  try {
    await sql.query(
      `UPDATE contact_embeddings AS ce
       SET embedding_vector = v.vec
       FROM (VALUES ${tuples}) AS v(id, vec)
       WHERE ce.id = v.id`,
      params
    );
    return valid.length;
  } catch (err) {
    console.error(
      `[backfillEmbeddingVectors] batched update failed for ${valid.length} rows, falling back to per-row:`,
      err
    );
  }

  let copied = 0;
  for (const row of valid) {
    try {
      const literal = formatVectorLiteral(row.embedding);
      await sql.query(
        `UPDATE contact_embeddings
         SET embedding_vector = $1::vector
         WHERE id = $2`,
        [literal, row.id]
      );
      copied += 1;
    } catch (err) {
      console.error(`[backfillEmbeddingVectors] failed to copy row ${row.id}:`, err);
    }
  }
  return copied;
}

/**
 * pgvector installs on Neon. The pinned `@electric-sql/pglite` (0.5.x, `^0.5.4`) has no
 * `vector` extension export — that moved to a separate `@electric-sql/pglite-pgvector`
 * package pinned to PGlite `0.5.8` — so this is only ever called on the Neon path. Local
 * dev intentionally degrades to the bounded in-memory cosine fallback (see
 * `src/lib/search.ts`). Revisit if PGlite is upgraded to >=0.5.8 alongside
 * `@electric-sql/pglite-pgvector`.
 */
async function migratePgvector(run: StatementRunner) {
  try {
    await run(`CREATE EXTENSION IF NOT EXISTS vector`);
    await run(
      `ALTER TABLE contact_embeddings ADD COLUMN IF NOT EXISTS embedding_vector vector(1536)`
    );
    await run(
      `CREATE INDEX IF NOT EXISTS embeddings_vector_hnsw_idx
       ON contact_embeddings USING hnsw (embedding_vector vector_cosine_ops)`
    );
    globalForDb.orbitPgvector = true;
  } catch {
    globalForDb.orbitPgvector = false;
  }
}

/**
 * Incremental columns and indexes for databases created before they existed. Applied by
 * BOTH drivers (PGlite is Postgres), in list order, AFTER the template's CREATE TABLEs and
 * BEFORE its indexes — see `applySchema`.
 */
const alters = [
  // Deliberately not backfilled from `committed_at` — see the column's comment in schema.ts.
  `ALTER TABLE fundraising_investors ADD COLUMN IF NOT EXISTS received_at timestamptz`,
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
  `ALTER TABLE interactions ADD COLUMN IF NOT EXISTS direction text`,
  `ALTER TABLE contacts ADD COLUMN IF NOT EXISTS constellation_pin text`,
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
  `ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS yc_mode_enabled boolean DEFAULT false`,
  `ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS estimated_monthly_churn_pct real`,
  `ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS stripe_customer_id text`,
  `ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS subscription_plan text`,
  `ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS subscription_status text`,
  `ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS subscription_period_end timestamptz`,
  `ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS subscription_monthly_cents integer`,
  `ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS subscription_interval text`,
  `ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS comped_note text`,
  `ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS comped_at timestamptz`,
  `ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS comped_by text`,
  `ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS last_active_at timestamptz`,
  `ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS first_name text`,
  `ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS last_name text`,
  `ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS profile_image_url text`,
  `ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS signup_referrer text`,
  `ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS signup_utm_source text`,
  `ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS signup_utm_medium text`,
  `ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS signup_utm_campaign text`,
  `ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS signup_landing_path text`,
  `ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS signup_attributed_at timestamptz`,
  `CREATE INDEX IF NOT EXISTS usage_events_user_created_idx ON usage_events(user_id, created_at)`,
  `CREATE INDEX IF NOT EXISTS usage_events_created_idx ON usage_events(created_at)`,
  `CREATE INDEX IF NOT EXISTS usage_events_model_idx ON usage_events(provider, model)`,
  `CREATE INDEX IF NOT EXISTS admin_audit_log_created_idx ON admin_audit_log(created_at)`,
  `CREATE INDEX IF NOT EXISTS admin_audit_log_target_idx ON admin_audit_log(target_user_id)`,
  // Instrumentation tables. The CREATE TABLEs in DDL above land on a fresh database;
  // these repair an existing one, which is why the indexes appear in both places.
  `CREATE INDEX IF NOT EXISTS cron_runs_job_started_idx ON cron_runs(job, started_at)`,
  `CREATE INDEX IF NOT EXISTS cron_runs_started_idx ON cron_runs(started_at)`,
  `CREATE INDEX IF NOT EXISTS webhook_deliveries_created_idx ON webhook_deliveries(created_at)`,
  `CREATE INDEX IF NOT EXISTS webhook_deliveries_event_idx ON webhook_deliveries(event_id)`,
  `CREATE INDEX IF NOT EXISTS webhook_deliveries_target_idx ON webhook_deliveries(target_user_id)`,
  `CREATE INDEX IF NOT EXISTS webhook_deliveries_type_created_idx ON webhook_deliveries(event_type, created_at)`,
  `CREATE INDEX IF NOT EXISTS error_events_created_idx ON error_events(created_at)`,
  `CREATE INDEX IF NOT EXISTS error_events_source_created_idx ON error_events(source, created_at)`,
  `CREATE INDEX IF NOT EXISTS error_events_user_created_idx ON error_events(user_id, created_at)`,
  `ALTER TABLE contacts ADD COLUMN IF NOT EXISTS school text`,
  `ALTER TABLE contacts ADD COLUMN IF NOT EXISTS profile_image_url text`,
  `ALTER TABLE contacts ADD COLUMN IF NOT EXISTS x_handle text`,
  `CREATE INDEX IF NOT EXISTS contacts_user_linkedin_idx ON contacts(user_id, linkedin_url)`,
  `CREATE INDEX IF NOT EXISTS contacts_user_x_idx ON contacts(user_id, x_handle)`,
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
  // Added a version after the table itself. A preview deployment of the branch that
  // introduced `interest_list_signups` already created it without these, and
  // CREATE TABLE IF NOT EXISTS will never go back and add a column to it.
  `ALTER TABLE interest_list_signups ADD COLUMN IF NOT EXISTS welcome_planet text`,
  `ALTER TABLE interest_list_signups ADD COLUMN IF NOT EXISTS follow_up_sent_at timestamptz`,

  // Feedback triage. The table shipped long before anything wrote to it, so every existing
  // database has it without these columns — and `CREATE TABLE IF NOT EXISTS` will never go
  // back and add one. Same reason the two `interest_list_signups` lines above exist.
  `ALTER TABLE feedback ADD COLUMN IF NOT EXISTS area text`,
  `ALTER TABLE feedback ADD COLUMN IF NOT EXISTS category text`,
  `ALTER TABLE feedback ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'new'`,
  `ALTER TABLE feedback ADD COLUMN IF NOT EXISTS status_changed_at timestamptz`,
  `ALTER TABLE feedback ADD COLUMN IF NOT EXISTS status_changed_by text`,
  `ALTER TABLE feedback ADD COLUMN IF NOT EXISTS resolution_note text`,
  `CREATE UNIQUE INDEX IF NOT EXISTS user_settings_calendar_feed_token_uidx ON user_settings(calendar_feed_token) WHERE calendar_feed_token IS NOT NULL`,
  `ALTER TABLE contacts ADD COLUMN IF NOT EXISTS stated_closeness integer`,
  `ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS recruiter_sharing integer NOT NULL DEFAULT 0`,
  `ALTER TABLE user_recruiter_links ADD COLUMN IF NOT EXISTS shared_to_pool integer NOT NULL DEFAULT 1`,
  `ALTER TABLE user_recruiter_links ADD COLUMN IF NOT EXISTS ai_summary text`,
  `ALTER TABLE user_recruiter_links ADD COLUMN IF NOT EXISTS companies_mentioned jsonb DEFAULT '[]'`,
  `ALTER TABLE user_recruiter_links ADD COLUMN IF NOT EXISTS roles_discussed jsonb DEFAULT '[]'`,
  `ALTER TABLE user_recruiter_links ADD COLUMN IF NOT EXISTS first_email_at timestamptz`,
  `ALTER TABLE user_recruiter_links ADD COLUMN IF NOT EXISTS last_email_at timestamptz`,
  `ALTER TABLE user_recruiter_links ADD COLUMN IF NOT EXISTS email_count integer NOT NULL DEFAULT 0`,
  `ALTER TABLE user_recruiter_links ADD COLUMN IF NOT EXISTS gmail_thread_id text`,
  `CREATE INDEX IF NOT EXISTS recruiter_messages_user_idx ON recruiter_messages(user_id, status)`,
  `CREATE INDEX IF NOT EXISTS recruiter_messages_recruiter_idx ON recruiter_messages(recruiter_id)`,
  `CREATE INDEX IF NOT EXISTS recruiter_messages_sent_idx ON recruiter_messages(user_id, sent_at)`,
  `ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS suspended_at timestamptz`,
  `ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS suspended_reason text`,
  `ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS suspended_by text`,
  // Schema v17: note processing provenance columns.
  `ALTER TABLE interactions ADD COLUMN IF NOT EXISTS note_batch_id uuid`,
  `ALTER TABLE reminders ADD COLUMN IF NOT EXISTS note_batch_id uuid`,
  `ALTER TABLE reminders ADD COLUMN IF NOT EXISTS source_interaction_id uuid REFERENCES interactions(id) ON DELETE SET NULL`,
  `ALTER TABLE reminders ADD COLUMN IF NOT EXISTS action_item_id uuid`,
  `ALTER TABLE reminders ADD COLUMN IF NOT EXISTS source_excerpt text`,
  `ALTER TABLE reminders ADD COLUMN IF NOT EXISTS raw_date_phrase text`,
  `ALTER TABLE reminders ADD COLUMN IF NOT EXISTS date_basis text`,
  `ALTER TABLE reminders ADD COLUMN IF NOT EXISTS item_hash text`,
  ...ADMIN_V2_STATEMENTS,
  // Embedding staleness: imports flag contacts here instead of embedding inline, and a
  // separate backfill drains them. The dedupe is safe to re-run — it only ever deletes
  // rows that lose the (user_id, contact_id, source_type, source_id) tiebreak, and once
  // the unique index exists no more duplicates can be created for it to find.
  //
  // `source_id` is part of the key because that is the real uniqueness contract:
  // `upsertContactEmbedding` keys its existence check on all four columns, and
  // calendar-sync writes one `"meeting"` row per meeting with a distinct `source_id`.
  // The DROP is load-bearing: an earlier revision created this same-named index on only
  // three columns, which would delete every meeting embedding but the newest and then
  // make each subsequent meeting write raise a swallowed unique violation. NULL
  // `source_id`s index as distinct (Postgres default), so unkeyed rows stay
  // unconstrained — matching the writer, which skips its existence check without one.
  `ALTER TABLE contacts ADD COLUMN IF NOT EXISTS embedding_stale_at timestamptz`,
  `CREATE INDEX IF NOT EXISTS contacts_embedding_stale_idx
   ON contacts(user_id) WHERE embedding_stale_at IS NOT NULL`,
  `DELETE FROM contact_embeddings a
   USING contact_embeddings b
   WHERE a.user_id = b.user_id
     AND a.contact_id = b.contact_id
     AND a.source_type = b.source_type
     AND a.source_id = b.source_id
     AND (a.created_at < b.created_at OR (a.created_at = b.created_at AND a.id < b.id))`,
  `DROP INDEX IF EXISTS embeddings_user_contact_source_uidx`,
  `CREATE UNIQUE INDEX IF NOT EXISTS embeddings_user_contact_source_id_uidx
   ON contact_embeddings(user_id, contact_id, source_type, source_id)`,
  // Schema v30: continuous provider sync. The same six columns on both connection tables —
  // they are byte-identical by design, and `syncStateColumns()` in schema.ts is the one
  // place their shape is written down.
  //
  // Deliberately no backfill of `next_sync_at`: NULL means "not scheduled", so nothing is
  // claimable until a connector exists to serve it. Arming existing connections is its own
  // statement, added once the Google Calendar connector lands.
  //
  // `sync_failures` is the only NOT NULL column here, and it carries a DEFAULT, so the
  // ALTER is safe on a populated table.
  ...["gmail_connections", "outlook_connections"].flatMap((table) => [
    `ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS sync_cursor jsonb`,
    `ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS next_sync_at timestamptz`,
    `ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS sync_status text`,
    `ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS sync_started_at timestamptz`,
    `ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS sync_error text`,
    `ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS sync_failures integer NOT NULL DEFAULT 0`,
    // The scheduler's claim orders by next_sync_at over the due rows only; the partial
    // predicate keeps the index to the handful of armed connections rather than every row.
    `CREATE INDEX IF NOT EXISTS ${table}_due_idx ON ${table}(next_sync_at) WHERE next_sync_at IS NOT NULL`,
  ]),
  // Arm the connections that already exist.
  //
  // `sync_status IS NULL` is the load-bearing half of this predicate, not decoration.
  // `next_sync_at IS NULL` alone means BOTH "never scheduled" and "deliberately disarmed
  // after repeated failure" — so on its own this statement would resurrect every known-dead
  // connection on every deploy, and the scheduler would claim, fail and disarm them again,
  // forever. Only a row the scheduler has never touched still has a NULL `sync_status`;
  // `disarmSync` always writes 'error'.
  //
  // Scoped to Google, because Google Calendar is the only connector that exists — arming an
  // Outlook row would have the scheduler claim it every run to find nothing to do. Outlook
  // joins when its calendar/mail scopes ship.
  //
  // Not scoped to `hasCalendarScope`, deliberately: a connection made before the scope shipped
  // needs to be claimed exactly once so the scheduler can disarm it with a message telling the
  // user to reconnect. Filtering it out here would leave it silently doing nothing instead.
  `UPDATE gmail_connections SET next_sync_at = now()
    WHERE status = 'active' AND next_sync_at IS NULL AND sync_status IS NULL`,
  // Schema v31: the connector platform. The CREATE TABLEs above land on a fresh database;
  // these repair an existing one, which is why every index appears in both places.
  `CREATE UNIQUE INDEX IF NOT EXISTS api_keys_hash_uidx ON api_keys(key_hash)`,
  `CREATE INDEX IF NOT EXISTS api_keys_user_idx ON api_keys(user_id)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS api_idempotency_uidx ON api_idempotency_keys(user_id, idempotency_key)`,
  `CREATE INDEX IF NOT EXISTS webhook_endpoints_user_idx ON webhook_endpoints(user_id)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS outbound_deliveries_endpoint_event_uidx ON outbound_webhook_deliveries(endpoint_id, event_id)`,
  `CREATE INDEX IF NOT EXISTS outbound_deliveries_due_idx ON outbound_webhook_deliveries(status, next_attempt_at)`,
  `CREATE INDEX IF NOT EXISTS outbound_deliveries_user_created_idx ON outbound_webhook_deliveries(user_id, created_at)`,
  // Schema v32: the events feature. Same rule as v31 above — the CREATE TABLEs repair a
  // fresh database, these repair an existing one, so every index is written in both places.
  //
  // The two unique indexes are the feature's whole idempotency story and must match their
  // `uniqueIndex()` declarations in schema.ts by name AND column list, or smoke-schema-ddl
  // fails: `events_provider_uidx` makes a provider re-sync update its event instead of
  // adding one, and `event_attendees_identity_uidx` makes re-pasting a roster a no-op.
  `CREATE INDEX IF NOT EXISTS events_user_idx ON events(user_id)`,
  `CREATE INDEX IF NOT EXISTS events_user_starts_idx ON events(user_id, starts_at, id)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS events_provider_uidx ON events(user_id, provider, provider_event_id) WHERE provider_event_id IS NOT NULL`,
  `CREATE INDEX IF NOT EXISTS event_attendees_event_idx ON event_attendees(event_id)`,
  `CREATE INDEX IF NOT EXISTS event_attendees_user_idx ON event_attendees(user_id)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS event_attendees_identity_uidx ON event_attendees(event_id, identity_key)`,
  `CREATE INDEX IF NOT EXISTS event_attendees_contact_idx ON event_attendees(contact_id) WHERE contact_id IS NOT NULL`,
  `CREATE UNIQUE INDEX IF NOT EXISTS event_provider_connections_user_uidx ON event_provider_connections(user_id, provider)`,
  `CREATE INDEX IF NOT EXISTS event_provider_connections_due_idx ON event_provider_connections(next_sync_at) WHERE next_sync_at IS NOT NULL`,
];

/**
 * Applies the bootstrap DDL in an order that cannot fail on an older database:
 *
 *   1. the template's CREATE TABLEs        (new tables, all columns, fresh databases)
 *   2. the template's ALTER TABLEs         (rare; columns the template itself adds)
 *   3. `alters`, in list order             (columns and indexes for older databases)
 *   4. everything else in the template     (indexes, which may name altered columns)
 *
 * The template used to run top to bottom, so `CREATE INDEX contacts_user_x_idx ON
 * contacts(x_handle)` ran before `alters` added `x_handle` to a pre-existing table. The
 * statement failed, the sweep carried on, the version was recorded anyway, and the index
 * has been silently missing from production since August 2026. Now: columns first, and
 * every real failure is returned rather than only logged.
 */
async function applySchema(run: StatementRunner, failed: SchemaFailure[]): Promise<void> {
  const statements = DDL.split(";")
    .map((s) => s.trim())
    .filter(Boolean);
  const tables = statements.filter((s) => /^CREATE TABLE/i.test(s));
  const columns = statements.filter((s) => /^ALTER TABLE/i.test(s));
  const rest = statements.filter((s) => !/^(CREATE TABLE|ALTER TABLE)/i.test(s));
  await runStatements(run, tables, "DDL", failed);
  await runStatements(run, columns, "DDL", failed);
  await runStatements(run, alters, "alters", failed);
  await runStatements(run, rest, "DDL", failed);
}

async function migrateNeon(sql: ReturnType<typeof neon>): Promise<SchemaFailure[]> {
  const failed: SchemaFailure[] = [];
  const run: StatementRunner = (statement) => sql.query(statement);
  await applySchema(run, failed);
  await migratePgvector(run);
  await applyScaleSchema(run, failed);
  return failed;
}

/**
 * Move an unopenable local PGlite directory aside so a fresh one can be created.
 * Returns the new path, or null if it could not be moved (in which case the caller should
 * surface the original open error rather than pretend it recovered).
 */
function quarantineDataDir(dataDir: string): string | null {
  try {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const quarantined = `${dataDir}-corrupt-${stamp}`;
    fs.renameSync(dataDir, quarantined);
    return quarantined;
  } catch {
    return null;
  }
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
    // `ORBIT_PGLITE_DIR` lets the smoke harness point every script at a throwaway
    // directory: PGlite is single-writer, and a dev server on `.data/pglite` must never
    // share it with a test. Unset in normal development.
    const dataDir = process.env.ORBIT_PGLITE_DIR || path.join(process.cwd(), ".data", "pglite");
    fs.mkdirSync(dataDir, { recursive: true });
    // Absolute string path — requires serverExternalPackages for @electric-sql/pglite.
    // `pg_trgm` has to be supplied at construction: PGlite loads extension bundles when the
    // instance is built, not on demand from `CREATE EXTENSION`. This is what gives local dev
    // the same fuzzy search as production. A vector build exists upstream only as a separate
    // package (`@electric-sql/pglite-pgvector`) pinned to a newer PGlite than the one this
    // project has installed; it is not installed here, so local vector search uses the JS
    // fallback instead.
    const open = () =>
      PGlite.create({ dataDir, extensions: { pg_trgm } });

    try {
      globalForDb.orbitPglite = await open();
    } catch (err) {
      // A local PGlite directory that will not open is not recoverable: the failure is a
      // bare WASM `Aborted()` with no diagnostics, and `pg_resetwal` is not available. It
      // happens when two processes write the directory at once (`next dev` plus a build or
      // a script) or when one exits without checkpointing, and until now it bricked local
      // development until someone deleted the directory by hand — with the real cause
      // buried under a stack trace that points at `PGlite.create`.
      //
      // So: quarantine it and start again. The directory is gitignored local fixture data,
      // it is already unreadable, and the schema is reapplied below automatically. Moved
      // rather than deleted, because it costs nothing to keep and the alternative is
      // destroying something on the user's behalf without being asked.
      const quarantined = quarantineDataDir(dataDir);
      if (!quarantined) throw err;

      console.error(
        `[orbit] Local database at ${dataDir} could not be opened and has been reset.\n` +
          `[orbit] The unreadable copy is at ${quarantined}.\n` +
          `[orbit] This is almost always two processes writing it at once — a build or a ` +
          `tsx script running while 'next dev' is up. Stop the dev server first.`
      );

      fs.mkdirSync(dataDir, { recursive: true });
      // The replacement directory is empty, so the DDL sweep has to run against it even if
      // an earlier open in this same process already marked the schema reconciled.
      schemaReconciled = undefined;
      globalForDb.orbitPglite = await open();
    }
  }

  await globalForDb.orbitPglite.waitReady;
}

/**
 * Flush and release the local PGlite instance.
 *
 * MUST be called before `process.exit()` by any script that writes to the local database.
 *
 * Scripts here exit with an explicit `process.exit(0)` (importing `next/server` anywhere
 * in the graph keeps the event loop alive, so draining is not an option). That terminates
 * the process without letting embedded Postgres checkpoint, which leaves `global/pg_control`
 * pointing at an older redo position than the WAL actually contains. The next open then
 * fails inside the WASM build with a bare `Aborted()` and no diagnostics, and there is no
 * `pg_resetwal` to repair it — the data directory is simply gone. That has happened once
 * already; it costs the whole local dev database.
 *
 * No-op against Neon: there is no local instance to close.
 */
export async function closeDb(): Promise<void> {
  const pglite = globalForDb.orbitPglite;
  if (!pglite) return;
  try {
    await pglite.close();
  } catch {
    // Already closed, or never finished opening. Nothing useful to do here.
  }
  globalForDb.orbitPglite = undefined;
  globalForDb.orbitDrizzle = undefined;
  globalForDb.orbitReady = undefined;
}

async function ready(): Promise<void> {
  if (!globalForDb.orbitReady) {
    globalForDb.orbitReady = ensureReady().catch((err) => {
      globalForDb.orbitReady = undefined;
      throw err;
    });
  }
  await globalForDb.orbitReady;
}

export type SchemaReconcileResult = {
  version: number;
  /** False when the recorded version already matched and nothing ran. */
  applied: boolean;
  failed: SchemaFailure[];
};

/**
 * Brings the connected database up to `SCHEMA_VERSION`, or confirms it already is.
 *
 * The whole sweep is idempotent, but "idempotent" is not "free": on `neon-http` every
 * statement is a separate HTTPS request, so replaying ~165 of them is the single largest
 * cost in a cold start. Confirm the recorded version first and skip the lot when it
 * already matches. A version mismatch — or any error reading it — takes the full pass.
 *
 * The version is recorded ONLY when nothing failed. A sweep that logged a failure and
 * recorded the version anyway is how an index went missing from production for a month
 * unnoticed; leaving the version behind instead keeps `/api/health` reporting
 * `schema_mismatch` until someone looks. The build-time migration (`scripts/migrate.ts`)
 * runs this ahead of `next build` and refuses to deploy on any failure, so in practice a
 * runtime boot only ever sees the no-op path.
 */
export async function reconcileSchema(): Promise<SchemaReconcileResult> {
  await ready();
  const neonSql = globalForDb.orbitNeonSql;
  const run: StatementRunner = neonSql
    ? (statement) => neonSql.query(statement)
    : (statement) => globalForDb.orbitPglite!.query(statement);

  if (await schemaIsCurrent(run)) {
    // pgvector/pg_trgm availability lives in module state, not in the database, so it
    // still has to be established on a boot that skips the DDL.
    await detectExtensions(run);
    return { version: SCHEMA_VERSION, applied: false, failed: [] };
  }

  const failed = neonSql
    ? await migrateNeon(neonSql)
    : await migratePglite(globalForDb.orbitPglite!);
  for (const f of failed) {
    console.error(`[db] DDL statement failed: ${f.statement}\n`, f.message);
  }
  if (failed.length === 0) await recordSchemaVersion(run);
  return { version: SCHEMA_VERSION, applied: true, failed };
}

export async function getDb(): Promise<Db> {
  await ready();

  if (!schemaReconciled) {
    schemaReconciled = reconcileSchema()
      .then(() => undefined)
      .catch((err) => {
        schemaReconciled = undefined;
        throw err;
      });
  }
  await schemaReconciled;

  // In dev the wrapper is rebuilt per call so schema HMR picks up new relations. In
  // production the schema cannot change under us, and `getDb()` is called dozens of times
  // per request — each rebuild reconstructs the relational query metadata from `schema`.
  if (process.env.NODE_ENV !== "production") {
    if (globalForDb.orbitNeonSql) {
      return drizzleNeon(globalForDb.orbitNeonSql, { schema, logger: countingLogger }) as Db;
    }
    return drizzlePglite(globalForDb.orbitPglite!, { schema, logger: countingLogger });
  }

  if (!globalForDb.orbitDrizzle) {
    globalForDb.orbitDrizzle = globalForDb.orbitNeonSql
      ? (drizzleNeon(globalForDb.orbitNeonSql, { schema, logger: countingLogger }) as Db)
      : drizzlePglite(globalForDb.orbitPglite!, { schema, logger: countingLogger });
  }
  return globalForDb.orbitDrizzle;
}

/**
 * A statement builder that both a live `Db` and a PGlite transaction satisfy. Both drizzle
 * instances are `PgDatabase`s and `PgTransaction extends PgDatabase`, so one type covers
 * the writer `runAtomicWrite` hands to its callback on either driver.
 */
export type AtomicWriter = PgDatabase<PgQueryResultHKT, typeof schema>;
/** One statement in an atomic group: any drizzle insert/update/delete/select builder. */
export type AtomicStatement = BatchItem<"pg">;

/**
 * Runs a group of statements atomically on whichever driver is live.
 *
 * `db.transaction()` is NOT an option: `getDb()` returns the `drizzle-orm/neon-http`
 * instance whenever `DATABASE_URL` is set — i.e. always in production — and that driver's
 * session throws `No transactions support in neon-http driver` unconditionally
 * (`node_modules/drizzle-orm/neon-http/session.cjs`). Neon's HTTP endpoint has no
 * cross-request session to hold a transaction open in.
 *
 * What it does have is `db.batch()`, which drizzle maps to `client.transaction(queries)` —
 * one HTTP request carrying every statement, committed or rolled back together. PGlite's
 * drizzle driver has no `batch` at all (only the batch-capable drivers — neon-http,
 * libsql, d1, planetscale — declare one), so the local path uses a real transaction
 * instead. Hence the callback shape rather than a plain array: the PGlite branch has to
 * build its statements against the transaction handle, or they would execute outside it.
 *
 * Callers must therefore never reach for `db.transaction` or `db.batch` directly — this is
 * the one place that knows which driver is underneath.
 */
export async function runAtomicWrite(
  db: Db,
  build: (writer: AtomicWriter) => AtomicStatement[]
): Promise<void> {
  const batchable = db as unknown as {
    batch?: (statements: AtomicStatement[]) => Promise<unknown>;
  };

  if (typeof batchable.batch === "function") {
    const statements = build(db as unknown as AtomicWriter);
    if (!statements.length) return;
    await batchable.batch(statements);
    return;
  }

  const local = db as ReturnType<typeof drizzlePglite<typeof schema>>;
  await local.transaction(async (tx) => {
    // Awaited one at a time on purpose: these are ordered writes (delete-then-insert),
    // and a `Promise.all` would let the driver interleave them.
    for (const statement of build(tx as unknown as AtomicWriter)) {
      await (statement as unknown as Promise<unknown>);
    }
  });
}

export { schema };
