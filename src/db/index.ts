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
  orbitDb?: Db;
  orbitPglite?: PGlite;
  orbitMigrated?: boolean;
  orbitInit?: Promise<Db>;
};

const DDL = `
CREATE TABLE IF NOT EXISTS user_settings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id text NOT NULL UNIQUE,
  openai_api_key_encrypted text,
  ai_model text DEFAULT 'gpt-4o-mini',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS contacts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id text NOT NULL,
  full_name text NOT NULL,
  first_name text,
  last_name text,
  company text,
  title text,
  location text,
  email text,
  phone text,
  linkedin_url text,
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

async function initDb(): Promise<Db> {
  const databaseUrl = process.env.DATABASE_URL?.trim();

  if (databaseUrl) {
    const sql = neon(databaseUrl);
    return drizzleNeon(sql, { schema });
  }

  const dataDir = path.join(process.cwd(), ".data", "pglite");
  fs.mkdirSync(dataDir, { recursive: true });

  if (!globalForDb.orbitPglite) {
    // Absolute string path — requires serverExternalPackages for @electric-sql/pglite
    globalForDb.orbitPglite = await PGlite.create({ dataDir });
  }

  const client = globalForDb.orbitPglite;
  await client.waitReady;

  if (!globalForDb.orbitMigrated) {
    await client.exec(DDL);
    globalForDb.orbitMigrated = true;
  }

  return drizzlePglite(client, { schema });
}

export async function getDb() {
  if (globalForDb.orbitDb) return globalForDb.orbitDb;

  if (!globalForDb.orbitInit) {
    globalForDb.orbitInit = initDb()
      .then((db) => {
        globalForDb.orbitDb = db;
        return db;
      })
      .catch((err) => {
        globalForDb.orbitInit = undefined;
        throw err;
      });
  }

  return globalForDb.orbitInit;
}

export { schema };
