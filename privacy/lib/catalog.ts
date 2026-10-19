/**
 * Catalog helpers for the privacy probes. Reads the LIVE schema of the throwaway PGlite
 * database (after `getDb()` has bootstrapped the full DDL), not `schema.ts`, so columns the
 * runtime adds outside Drizzle (e.g. `embedding_vector`) are seen too.
 *
 * Never point this at a real database: every probe imports `scripts/smoke/_env` first, which
 * deletes DATABASE_URL and strips provider keys.
 */
import { sql } from "drizzle-orm";
import { getDb, rowsOf } from "../../src/db";

export type Column = {
  table: string;
  column: string;
  type: string; // format_type(), e.g. "text", "jsonb", "text[]", "uuid", "vector(768)"
  notNull: boolean;
  hasDefault: boolean;
  defaultExpr: string | null; // pg_get_expr of the column default, e.g. "'[]'::jsonb"
  generated: boolean;
  identity: boolean;
};

export type ForeignKey = {
  table: string;
  columns: string[];
  refTable: string;
  refColumns: string[];
  onDelete: string; // a=no action, r=restrict, c=cascade, n=set null, d=set default
};

export type Catalog = {
  tables: string[];
  columns: Map<string, Column[]>;
  fks: ForeignKey[];
  checks: Map<string, string[]>; // table -> check constraint definitions
  uniques: Map<string, string[][]>; // table -> unique/PK column sets
};

export async function readCatalog(): Promise<Catalog> {
  const db = await getDb();
  const cols = rowsOf<{
    table_name: string;
    column_name: string;
    type: string;
    not_null: boolean;
    has_default: boolean;
    default_expr: string | null;
    generated: string;
    identity: string;
  }>(
    await db.execute(sql`
      SELECT c.relname AS table_name, a.attname AS column_name,
             format_type(a.atttypid, a.atttypmod) AS type,
             a.attnotnull AS not_null, a.atthasdef AS has_default,
             pg_get_expr(d.adbin, d.adrelid) AS default_expr,
             a.attgenerated::text AS generated, a.attidentity::text AS identity
        FROM pg_attribute a
        JOIN pg_class c ON c.oid = a.attrelid
        JOIN pg_namespace n ON n.oid = c.relnamespace
        LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
       WHERE n.nspname = 'public' AND c.relkind = 'r' AND a.attnum > 0 AND NOT a.attisdropped
       ORDER BY c.relname, a.attnum`)
  );
  const columns = new Map<string, Column[]>();
  for (const r of cols) {
    const list = columns.get(r.table_name) ?? [];
    list.push({
      table: r.table_name,
      column: r.column_name,
      type: r.type,
      notNull: r.not_null,
      hasDefault: r.has_default,
      defaultExpr: r.default_expr ?? null,
      generated: (r.generated ?? "") !== "",
      identity: (r.identity ?? "") !== "",
    });
    columns.set(r.table_name, list);
  }

  const fkRows = rowsOf<{
    table_name: string;
    cols: string[] | string;
    ref_table: string;
    ref_cols: string[] | string;
    del: string;
  }>(
    await db.execute(sql`
      SELECT c.relname AS table_name,
             (SELECT array_agg(a.attname ORDER BY k.ord) FROM unnest(con.conkey) WITH ORDINALITY k(n, ord)
                JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = k.n) AS cols,
             rc.relname AS ref_table,
             (SELECT array_agg(a.attname ORDER BY k.ord) FROM unnest(con.confkey) WITH ORDINALITY k(n, ord)
                JOIN pg_attribute a ON a.attrelid = con.confrelid AND a.attnum = k.n) AS ref_cols,
             con.confdeltype::text AS del
        FROM pg_constraint con
        JOIN pg_class c ON c.oid = con.conrelid
        JOIN pg_class rc ON rc.oid = con.confrelid
        JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE con.contype = 'f' AND n.nspname = 'public'`)
  );
  const arr = (v: string[] | string) =>
    Array.isArray(v) ? v : String(v).replace(/^\{|\}$/g, "").split(",").filter(Boolean);
  const fks: ForeignKey[] = fkRows.map((r) => ({
    table: r.table_name,
    columns: arr(r.cols),
    refTable: r.ref_table,
    refColumns: arr(r.ref_cols),
    onDelete: r.del,
  }));

  const checkRows = rowsOf<{ table_name: string; def: string }>(
    await db.execute(sql`
      SELECT c.relname AS table_name, pg_get_constraintdef(con.oid) AS def
        FROM pg_constraint con JOIN pg_class c ON c.oid = con.conrelid
        JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE con.contype = 'c' AND n.nspname = 'public'`)
  );
  const checks = new Map<string, string[]>();
  for (const r of checkRows) checks.set(r.table_name, [...(checks.get(r.table_name) ?? []), r.def]);

  const uniqRows = rowsOf<{ table_name: string; cols: string[] | string }>(
    await db.execute(sql`
      SELECT c.relname AS table_name,
             (SELECT array_agg(a.attname) FROM unnest(con.conkey) k(n)
                JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = k.n) AS cols
        FROM pg_constraint con JOIN pg_class c ON c.oid = con.conrelid
        JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE con.contype IN ('u','p') AND n.nspname = 'public'`)
  );
  const uniques = new Map<string, string[][]>();
  for (const r of uniqRows) uniques.set(r.table_name, [...(uniques.get(r.table_name) ?? []), arr(r.cols)]);

  return { tables: [...columns.keys()].sort(), columns, fks, checks, uniques };
}

/** Column names that identify an account holder (not necessarily via `user_id`). */
export const USER_REF = /^(user_id|.*_user_id|.*_by|owner_id|inviter_id|invitee_id|referrer_id|referred_user_id|clerk_user_id|actor_id|admin_id)$/;
/** Column names that very likely hold direct personal identifiers. */
export const PII_NAME = /(email|phone|full_name|first_name|last_name|^name$|display_name|linkedin|address|ip|user_agent|avatar|photo|image_url|birthday|location|city|handle|username)/i;
/** Column names that likely hold free text about people (notes, transcripts, prompts, AI output). */
export const PROSE_NAME = /(text|body|note|summary|transcript|content|message|prompt|answer|result|snapshot|payload|raw|description|bio|headline|subject|context|reason|detail|metadata|data|excerpt|snippet)/i;

export function isTextish(type: string): boolean {
  return /^(text|character varying.*|varchar.*|jsonb?|text\[\]|character varying\[\]|citext)$/.test(type);
}
