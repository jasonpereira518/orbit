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
let schemaReconciled = false;

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
CREATE TABLE IF NOT EXISTS reminders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id text NOT NULL,
  contact_id uuid REFERENCES contacts(id) ON DELETE CASCADE,
  title text NOT NULL,
  description text,
  due_date timestamptz,
  status text NOT NULL DEFAULT 'pending',
  reminder_type text NOT NULL DEFAULT 'manual',
  created_by text NOT NULL DEFAULT 'user',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS imports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id text NOT NULL,
  import_type text NOT NULL,
  file_name text,
  status text NOT NULL DEFAULT 'pending',
  rows_processed integer DEFAULT 0,
  contacts_created integer DEFAULT 0,
  contacts_updated integer DEFAULT 0,
  duplicates_found integer DEFAULT 0,
  error_message text,
  stats jsonb DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
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
CREATE UNIQUE INDEX IF NOT EXISTS interactions_user_external_uidx ON interactions(user_id, external_id) WHERE external_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS reminders_user_status_idx ON reminders(user_id, status);
CREATE INDEX IF NOT EXISTS reminders_due_idx ON reminders(user_id, due_date);
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
  tone text DEFAULT 'professional',
  default_channel text DEFAULT 'email',
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
  sent_at timestamptz,
  last_action_at timestamptz,
  error_message text,
  delivery_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS outreach_messages_prospect_idx ON outreach_messages(prospect_id);
CREATE INDEX IF NOT EXISTS outreach_messages_status_idx ON outreach_messages(status);
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
  await client.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
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
  await ensureColumn(client, "user_settings", "apollo_api_key_encrypted", "text");
  await ensureColumn(client, "user_settings", "resend_api_key_encrypted", "text");
  await ensureColumn(client, "user_settings", "twilio_account_sid_encrypted", "text");
  await ensureColumn(client, "user_settings", "twilio_auth_token_encrypted", "text");
  await ensureColumn(client, "user_settings", "twilio_from_number", "text");
  await ensureColumn(client, "user_settings", "theme", "text");
  await ensureColumn(client, "contacts", "school", "text");
  await ensureColumn(client, "contacts", "profile_image_url", "text");

  try {
    await client.exec(
      `CREATE UNIQUE INDEX IF NOT EXISTS interactions_user_external_uidx
       ON interactions(user_id, external_id)
       WHERE external_id IS NOT NULL`
    );
  } catch {
    // Existing duplicate external_ids — app-level dedupe still applies
  }
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
    } catch {
      // Older Postgres variants / race — continue so later alters can recover
    }
  }

  // Incremental columns for older Neon DBs created before these existed.
  const alters = [
    `ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS onboarding_completed_at timestamptz`,
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
    `ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS apollo_api_key_encrypted text`,
    `ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS resend_api_key_encrypted text`,
    `ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS twilio_account_sid_encrypted text`,
    `ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS twilio_auth_token_encrypted text`,
    `ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS twilio_from_number text`,
    `ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS theme text`,
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
    `CREATE INDEX IF NOT EXISTS ai_suggestions_user_idx ON ai_suggestions(user_id, status)`,
    `CREATE INDEX IF NOT EXISTS embeddings_user_idx ON contact_embeddings(user_id)`,
    `CREATE INDEX IF NOT EXISTS embeddings_contact_idx ON contact_embeddings(contact_id)`,
    `CREATE TABLE IF NOT EXISTS chat_threads (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id text NOT NULL,
      title text,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    )`,
    `CREATE INDEX IF NOT EXISTS chat_threads_user_idx ON chat_threads(user_id)`,
    `CREATE INDEX IF NOT EXISTS chat_threads_user_updated_idx ON chat_threads(user_id, updated_at)`,
    `CREATE TABLE IF NOT EXISTS chat_messages (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      thread_id uuid NOT NULL REFERENCES chat_threads(id) ON DELETE CASCADE,
      user_id text NOT NULL,
      role text NOT NULL,
      content text NOT NULL,
      recommendations jsonb,
      created_at timestamptz NOT NULL DEFAULT now()
    )`,
    `CREATE INDEX IF NOT EXISTS chat_messages_thread_idx ON chat_messages(thread_id)`,
    `CREATE INDEX IF NOT EXISTS chat_messages_user_idx ON chat_messages(user_id)`,
  ];

  for (const statement of alters) {
    try {
      await sql.query(statement);
    } catch {
      // Older Postgres variants / race — ignore
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
    if (globalForDb.orbitNeonSql) {
      await migrateNeon(globalForDb.orbitNeonSql);
    } else {
      await migratePglite(globalForDb.orbitPglite!);
    }
    schemaReconciled = true;
  }

  // Rebuild the drizzle wrapper each call so schema HMR picks up new relations.
  if (globalForDb.orbitNeonSql) {
    return drizzleNeon(globalForDb.orbitNeonSql, { schema }) as Db;
  }
  return drizzlePglite(globalForDb.orbitPglite!, { schema });
}

export { schema };
