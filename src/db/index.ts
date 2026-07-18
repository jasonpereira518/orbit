import { drizzle as drizzleNeon } from "drizzle-orm/neon-http";
import { neon } from "@neondatabase/serverless";
import { drizzle as drizzlePglite } from "drizzle-orm/pglite";
import { PGlite } from "@electric-sql/pglite";
import * as schema from "./schema";
import path from "node:path";
import fs from "node:fs";

type Db =
  | ReturnType<typeof drizzleNeon<typeof schema>>
  | ReturnType<typeof drizzlePglite<typeof schema>>;

const globalForDb = globalThis as unknown as {
  orbitPglite?: PGlite;
  orbitNeonSql?: ReturnType<typeof neon>;
  orbitMigrated?: boolean;
  orbitReady?: Promise<void>;
};

const DDL = `
CREATE TABLE IF NOT EXISTS user_settings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id text NOT NULL UNIQUE,
  gemini_api_key_encrypted text,
  ai_model text DEFAULT 'gemini-3.5-flash',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS contacts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id text NOT NULL,
  full_name text NOT NULL,
  first_name text,
  last_name text,
  preferred_name text,
  company text,
  title text,
  location text,
  email text,
  phone text,
  linkedin_url text,
  website text,
  profile_image_url text,
  relationship_score integer NOT NULL DEFAULT 2,
  priority_level integer NOT NULL DEFAULT 0,
  source text,
  industry text,
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
  source text,
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
  created_at timestamptz NOT NULL DEFAULT now()
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
  await ensureColumn(client, "contacts", "preferred_name", "text");
  await ensureColumn(client, "contacts", "website", "text");
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

  const client = globalForDb.orbitPglite;
  await client.waitReady;

  // Always reconcile schema so HMR / older .data dirs pick up new columns
  await migratePglite(client);
  globalForDb.orbitMigrated = true;
}

export async function getDb(): Promise<Db> {
  if (!globalForDb.orbitReady) {
    globalForDb.orbitReady = ensureReady().catch((err) => {
      globalForDb.orbitReady = undefined;
      throw err;
    });
  }
  await globalForDb.orbitReady;

  // Rebuild the drizzle wrapper each call so schema HMR picks up new relations.
  if (globalForDb.orbitNeonSql) {
    return drizzleNeon(globalForDb.orbitNeonSql, { schema });
  }
  return drizzlePglite(globalForDb.orbitPglite!, { schema });
}

export { schema };
