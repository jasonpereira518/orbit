/**
 * Generic, catalog-driven seeder for the privacy probes.
 *
 * Inserts one row into (nearly) every table on behalf of a fake user. Every text value it
 * writes CONTAINS that user's id (`<userId>|<table>.<column>`), every email is
 * `<userId>@example.test`, and every jsonb value is `{"m": "<userId>|…"}` — so after a
 * deletion, `row::text LIKE '%<userId>%'` over the whole database finds every surviving copy
 * of that user's data, by table and column, with no hand-maintained list to drift.
 *
 * Child rows reference the parent row seeded for the SAME user, so cascades are exercised.
 * Operator-only tables (fundraising, infra costs, …) are seeded with a neutral marker.
 * Columns constrained by a CHECK with an allowed-value list get the first allowed value.
 *
 * Fake data only. Never run against anything but the throwaway PGlite directory that
 * `scripts/smoke/_env` sets up.
 */
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { getDb, rowsOf } from "../../src/db";
import type { Catalog, Column, ForeignKey } from "./catalog";

/** Tables that hold operator/business data, not data about an account holder or contact. */
export const OPERATOR_TABLES = new Set([
  "acquisition_spend",
  "admin_provider_snapshots",
  "app_surface_flags",
  "cash_snapshots",
  "constellation_settings",
  "cron_runs",
  "external_item_companies",
  "external_items",
  "external_sources",
  "fundraising_investors",
  "fundraising_rounds",
  "infra_costs",
  "job_feed_sources",
  "job_postings",
  "non_dilutive_funding",
  "ops_alert_state",
  "org_brand_colors",
  "schema_migration_lock",
  "schema_migrations",
  "site_settings",
  "startup_expenses",
  "stripe_processed_events",
  "broadcasts",
]);

export type SeedReport = {
  seeded: Map<string, Record<string, unknown>>;
  failed: Map<string, string>;
};

/** Allowed literal values per column, parsed from CHECK constraints. */
function allowedValues(defs: string[]): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const def of defs) {
    // (col = ANY (ARRAY['a'::text, 'b'::text]))
    for (const m of def.matchAll(/\(?(\w+)\)?(?:::text)?\s*=\s*ANY\s*\(\s*\(?ARRAY\[([^\]]+)\]/g)) {
      const vals = [...m[2].matchAll(/'([^']*)'/g)].map((x) => x[1]);
      const nums = vals.length ? vals : m[2].split(",").map((s) => s.trim().replace(/::\w+.*$/, ""));
      if (!out.has(m[1])) out.set(m[1], nums);
    }
    // (col = 'a'::text) OR (col = 'b'::text)
    for (const m of def.matchAll(/\(?(\w+)\)?\s*=\s*'([^']*)'::/g)) {
      if (!out.has(m[1])) out.set(m[1], [m[2]]);
    }
    // col IN ('a','b')
    for (const m of def.matchAll(/(\w+)\s+IN\s*\(([^)]+)\)/gi)) {
      const vals = [...m[2].matchAll(/'([^']*)'/g)].map((x) => x[1]);
      if (vals.length && !out.has(m[1])) out.set(m[1], vals);
    }
  }
  return out;
}

function columnsInCheck(def: string, cols: Column[]): Column[] {
  return cols.filter((c) => new RegExp(`\\b${c.column}\\b`).test(def));
}

function topoOrder(cat: Catalog): string[] {
  const deps = new Map<string, Set<string>>();
  for (const t of cat.tables) deps.set(t, new Set());
  for (const fk of cat.fks) if (fk.table !== fk.refTable) deps.get(fk.table)?.add(fk.refTable);
  const order: string[] = [];
  const state = new Map<string, number>();
  const visit = (t: string) => {
    if (state.get(t) === 2) return;
    if (state.get(t) === 1) return; // cycle: break it, FK will be nulled if nullable
    state.set(t, 1);
    for (const d of deps.get(t) ?? []) visit(d);
    state.set(t, 2);
    order.push(t);
  };
  for (const t of cat.tables) visit(t);
  return order;
}

function literalFor(col: Column, marker: string, owner: string, allowed?: string[]): unknown {
  const t = col.type;
  if (allowed?.length) return allowed[0];
  if (/email/i.test(col.column) && /^(text|character varying.*|citext)$/.test(t)) return `${owner}@example.test`;
  if (/^(text|character varying.*|citext)$/.test(t)) return marker;
  if (t === "jsonb" || t === "json") return { m: marker };
  if (/\[\]$/.test(t) && /^(text|character varying)/.test(t)) return [marker];
  if (t === "uuid") return randomUUID();
  if (t === "uuid[]") return [randomUUID()];
  if (/^(integer|smallint|bigint|numeric.*|real|double precision)$/.test(t)) return 1;
  if (/^(integer|bigint|smallint|numeric.*|real|double precision)\[\]$/.test(t)) return [1];
  if (t === "boolean") return false;
  if (/^timestamp/.test(t)) return new Date();
  if (t === "date") return new Date().toISOString().slice(0, 10);
  if (t === "time without time zone") return "09:00";
  if (t === "interval") return "1 day";
  if (t === "bytea") return Buffer.from(marker);
  if (t === "inet") return "192.0.2.1";
  return undefined; // vector(...), tsvector, unknown: leave to default / null
}

function sqlValue(v: unknown, col: Column) {
  if (v === null) return sql`NULL`;
  if (v instanceof Date) return sql`${v.toISOString()}::timestamptz`;
  if (Buffer.isBuffer(v)) return sql`decode(${v.toString("hex")}, 'hex')`;
  if (Array.isArray(v)) return sql`${`{${v.map((x) => JSON.stringify(String(x))).join(",")}}`}::${sql.raw(col.type)}`;
  if (typeof v === "object") return sql`${JSON.stringify(v)}::${sql.raw(col.type)}`;
  return sql`${v}::${sql.raw(col.type)}`;
}

/**
 * Seed every table for `owner`. `parents` lets a second call (another user) reuse nothing:
 * each user gets its own parent rows.
 */
export async function seedEverything(cat: Catalog, owner: string, opts: { skip?: Set<string> } = {}): Promise<SeedReport> {
  const db = await getDb();
  const seeded = new Map<string, Record<string, unknown>>();
  const failed = new Map<string, string>();
  const fkByTable = new Map<string, ForeignKey[]>();
  for (const fk of cat.fks) fkByTable.set(fk.table, [...(fkByTable.get(fk.table) ?? []), fk]);

  for (const table of topoOrder(cat)) {
    if (opts.skip?.has(table)) continue;
    const isOperator = OPERATOR_TABLES.has(table);
    const who = isOperator ? "OPERATOR" : owner;
    const cols = cat.columns.get(table)!.filter((c) => !c.generated && !c.identity);
    const allowed = allowedValues(cat.checks.get(table) ?? []);
    const fks = fkByTable.get(table) ?? [];
    const nulled = new Set<string>();
    const omitted = new Set<string>();

    let lastErr = "";
    for (let attempt = 0; attempt < 6; attempt++) {
      const values = new Map<string, unknown>();
      let blocked = "";
      for (const col of cols) {
        if (omitted.has(col.column)) continue;
        if (nulled.has(col.column)) {
          values.set(col.column, null);
          continue;
        }
        const fk = fks.find((f) => f.columns.length === 1 && f.columns[0] === col.column);
        if (fk) {
          const parent = fk.refTable === table ? undefined : seeded.get(fk.refTable);
          if (parent && parent[fk.refColumns[0]] !== undefined) values.set(col.column, parent[fk.refColumns[0]]);
          else if (!col.notNull) values.set(col.column, null);
          else blocked = `parent ${fk.refTable} not seeded`;
          continue;
        }
        const multi = fks.find((f) => f.columns.length > 1 && f.columns.includes(col.column));
        if (multi) {
          const parent = seeded.get(multi.refTable);
          const idx = multi.columns.indexOf(col.column);
          if (parent) values.set(col.column, parent[multi.refColumns[idx]]);
          else if (!col.notNull) values.set(col.column, null);
          else blocked = `parent ${multi.refTable} not seeded`;
          continue;
        }
        if (col.column === "user_id" || /^(target_user_id|created_by_user_id|referred_user_id|clerk_user_id)$/.test(col.column)) {
          values.set(col.column, who);
          continue;
        }
        const v = literalFor(col, `${who}|${table}.${col.column}`, who, allowed.get(col.column));
        if (v !== undefined) values.set(col.column, v);
        else if (col.notNull && !col.hasDefault) blocked = `no literal for ${col.column} ${col.type}`;
      }
      if (blocked) {
        lastErr = blocked;
        break;
      }
      const names = [...values.keys()];
      try {
        const res = await db.execute(sql`
          INSERT INTO ${sql.identifier(table)} (${sql.join(names.map((n) => sql.identifier(n)), sql`, `)})
          VALUES (${sql.join(names.map((n) => sqlValue(values.get(n), cols.find((c) => c.column === n)!)), sql`, `)})
          RETURNING *`);
        seeded.set(table, rowsOf<Record<string, unknown>>(res)[0]);
        lastErr = "";
        break;
      } catch (err) {
        const e = err as { message?: string; cause?: { message?: string; constraint?: string } };
        const msg = e.cause?.message ?? e.message ?? String(err);
        lastErr = msg.split("\n")[0].slice(0, 200);
        // Relax whatever the constraint mentions: null it if nullable, else let the default apply.
        const constraintName = e.cause?.constraint ?? (msg.match(/constraint "([^"]+)"/)?.[1] ?? "");
        const checkDefs = cat.checks.get(table) ?? [];
        const involved = new Set<Column>();
        const colMatch = msg.match(/column "([^"]+)"/);
        if (colMatch) for (const c of cols) if (c.column === colMatch[1]) involved.add(c);
        if (constraintName) for (const def of checkDefs) for (const c of columnsInCheck(def, cols)) involved.add(c);
        if (involved.size === 0) for (const def of checkDefs) for (const c of columnsInCheck(def, cols)) involved.add(c);
        let changed = false;
        for (const c of involved) {
          if (!c.notNull && !nulled.has(c.column)) {
            nulled.add(c.column);
            changed = true;
          } else if (c.hasDefault && !omitted.has(c.column)) {
            omitted.add(c.column);
            changed = true;
          }
        }
        if (!changed) break;
      }
    }
    if (lastErr) failed.set(table, lastErr);
  }
  return { seeded, failed };
}

/** Every table whose row text contains `needle`, with a per-column breakdown. */
export async function scanFor(cat: Catalog, needle: string): Promise<Map<string, { rows: number; columns: string[] }>> {
  const db = await getDb();
  const out = new Map<string, { rows: number; columns: string[] }>();
  for (const table of cat.tables) {
    const res = await db.execute(
      sql`SELECT count(*)::int AS n FROM ${sql.identifier(table)} t WHERE t::text LIKE ${`%${needle}%`}`
    );
    const n = rowsOf<{ n: number }>(res)[0]?.n ?? 0;
    if (!n) continue;
    const columns: string[] = [];
    for (const col of cat.columns.get(table)!) {
      if (/^vector/.test(col.type) || col.type === "tsvector") continue;
      const r = await db.execute(
        sql`SELECT count(*)::int AS n FROM ${sql.identifier(table)} WHERE ${sql.identifier(col.column)}::text LIKE ${`%${needle}%`}`
      );
      if ((rowsOf<{ n: number }>(r)[0]?.n ?? 0) > 0) columns.push(col.column);
    }
    out.set(table, { rows: n, columns });
  }
  return out;
}
