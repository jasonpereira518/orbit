/**
 * Guards the three invariants that keep the hand-maintained bootstrap DDL in
 * `src/db/index.ts` honest. Orbit deliberately does not use `drizzle-kit push` (it would
 * drop the runtime-created `contact_embeddings.embedding_vector` column and its HNSW
 * index), so every column is carried by hand — and hand-maintained lists drift.
 *
 *   1. COVERAGE — every column in `schema.ts` is created by some statement: the `DDL`
 *      template, the Neon `alters` list, the PGlite `ensureColumn` calls, or `SCALE_DDL`.
 *      A column that exists only in `schema.ts` lives solely in local databases that were
 *      once built with `push`; the Neon database never gets it and the first `select`
 *      naming it fails with 42703.
 *
 *   2. INDEX PARITY — every `uniqueIndex` declared in `schema.ts` has a matching
 *      `CREATE UNIQUE INDEX` in the DDL, by name AND by column list. Nothing at runtime
 *      reads Drizzle's index metadata, so a stale declaration is invisible until someone
 *      runs `drizzle-kit push`/`generate` — which `package.json` still ships as
 *      `db:push`/`db:generate`, and `drizzle.config.ts` points at this schema. A key that
 *      disagrees with the DDL therefore sits harmless until the day it is applied to
 *      whatever `DATABASE_URL` resolves to, and then rewrites a live uniqueness contract.
 *      This check exists because that happened: `embeddings_user_contact_source_uidx` was
 *      corrected in all three hand-written SQL sites and left stale in `schema.ts`, where
 *      the column check below could not see it — it iterates `table.columns` and never
 *      looked at indexes at all.
 *
 *   3. VERSION — if the DDL changed, `SCHEMA_VERSION` was bumped. `getDb()` skips the
 *      entire migration sweep when the version recorded in `schema_migrations` already
 *      matches, so DDL that lands without a bump never runs on any instance that has
 *      already migrated. This is not hypothetical: #41 added six `user_settings` columns
 *      without bumping past 3, the production sweep short-circuited on every cold start,
 *      and `/dashboard` 500'd on `column "first_name" does not exist`.
 *
 * The fingerprint in `schema-ddl.lock.json` is the set of DDL statements, normalized and
 * sorted, so comment and formatting edits do not trip it — only real DDL changes do.
 * After intentionally changing DDL: bump `SCHEMA_VERSION`, then run with `--update`.
 *
 * Purely static: reads the two files and compares them. Touches no database, so it
 * needs no environment and is safe to run in CI.
 *
 * Run:    npx tsx scripts/smoke-schema-ddl.ts
 * Update: npx tsx scripts/smoke-schema-ddl.ts --update
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { is } from "drizzle-orm";
import { PgTable, getTableConfig } from "drizzle-orm/pg-core";
import * as schema from "../src/db/schema";

const SOURCE = path.join(process.cwd(), "src", "db", "index.ts");
const LOCK = path.join(process.cwd(), "scripts", "schema-ddl.lock.json");
const src = fs.readFileSync(SOURCE, "utf8");

/**
 * Text of a named array-of-template-literals declaration, e.g. `SCALE_DDL` or `alters`.
 * Tolerates a type annotation (`SCALE_DDL: string[] = [`) and finds the closing bracket
 * by depth, skipping over template literals so SQL containing brackets cannot end it early.
 */
function arrayBlock(name: string): string {
  // Anchored to the declaration keyword: the names are also mentioned in prose in the
  // surrounding comments, and a looser pattern happily matches those instead.
  const decl = new RegExp(
    `(?:export\\s+)?const\\s+${name}\\s*(?::\\s*[\\w<>\\[\\]|\\s]+?)?=\\s*\\[`
  );
  const m = src.match(decl);
  if (m?.index === undefined) {
    throw new Error(`Could not locate \`${name}\` in src/db/index.ts — update this guard.`);
  }

  const open = src.indexOf("[", m.index + m[0].length - 1);
  let depth = 0;
  let inTemplate = false;

  for (let i = open; i < src.length; i += 1) {
    const ch = src[i];
    if (ch === "\\") {
      i += 1;
      continue;
    }
    if (ch === "`") {
      inTemplate = !inTemplate;
      continue;
    }
    if (inTemplate) continue;
    if (ch === "[") depth += 1;
    else if (ch === "]") {
      depth -= 1;
      if (depth === 0) return src.slice(open, i + 1);
    }
  }

  throw new Error(`Could not find the end of \`${name}\` — update this guard.`);
}

function functionBlock(name: string, nextName: string): string {
  const start = src.indexOf(`async function ${name}`);
  const end = src.indexOf(`async function ${nextName}`);
  if (start < 0 || end < 0 || end <= start) {
    throw new Error(
      `Could not locate ${name}/${nextName} in src/db/index.ts — update this guard.`
    );
  }
  return src.slice(start, end);
}

const ddlTemplate = (() => {
  const m = src.match(/const DDL = `([\s\S]*?)`;/);
  if (!m) throw new Error("Could not locate the `DDL` template — update this guard.");
  return m[1];
})();

const scaleDdl = arrayBlock("SCALE_DDL");
const alters = arrayBlock("alters");
const adminV2 = arrayBlock("ADMIN_V2_STATEMENTS");
const pgliteBody = functionBlock("migratePglite", "migrateNeon");

// ---------------------------------------------------------------- coverage

type ColumnSets = Map<string, Set<string>>;

function add(map: ColumnSets, table: string, column: string) {
  if (!map.has(table)) map.set(table, new Set());
  map.get(table)!.add(column);
}

/** Columns the CREATE TABLE blocks bring into being (in `DDL` and in `SCALE_DDL`). */
function createdColumns(): ColumnSets {
  const map: ColumnSets = new Map();
  for (const text of [ddlTemplate, scaleDdl]) {
    for (const [, table, body] of text.matchAll(
      /CREATE TABLE IF NOT EXISTS (\w+) \(([\s\S]*?)\n\s*\)/g
    )) {
      for (const line of body.split("\n")) {
        const name = line.trim().split(/\s+/)[0]?.replace(/[(),]/g, "");
        // Skip table-level constraint clauses, which start with a keyword.
        if (name && !/^(PRIMARY|UNIQUE|FOREIGN|CONSTRAINT|CHECK|REFERENCES)$/i.test(name)) {
          add(map, table, name);
        }
      }
      // A table with a CREATE TABLE is registered even if the body parsed to nothing.
      if (!map.has(table)) map.set(table, new Set());
    }
  }
  return map;
}

/** Columns added by ALTER ... ADD COLUMN, per source list. */
function alteredColumns(text: string): ColumnSets {
  const map: ColumnSets = new Map();
  for (const [, table, column] of text.matchAll(
    /ALTER TABLE (\w+)\s+ADD COLUMN IF NOT EXISTS (\w+)/g
  )) {
    add(map, table, column);
  }
  return map;
}

/** Columns added by the PGlite `ensureColumn` helper. */
function ensuredColumns(text: string): ColumnSets {
  const map: ColumnSets = new Map();
  for (const [, table, column] of text.matchAll(
    /ensureColumn\(\s*client,\s*"(\w+)",\s*"(\w+)"/g
  )) {
    add(map, table, column);
  }
  return map;
}

const created = createdColumns();
// SCALE_DDL is applied by both drivers via `applyScaleSchema`, so it counts for each.
const scaleAlters = alteredColumns(scaleDdl);
const neonAlters = alteredColumns(alters);
const pgliteEnsured = ensuredColumns(pgliteBody);

/**
 * Columns created at runtime rather than by the bootstrap DDL, so they are absent from
 * `schema.ts` by design and must not be reported as drift in either direction.
 */
const RUNTIME_MANAGED = new Set(["contact_embeddings.embedding_vector"]);

/**
 * Unique indexes the DDL creates, keyed by index name. Parsed from the whole of
 * `src/db/index.ts` rather than from the four statement lists the fingerprint walks,
 * because unique indexes are created in more places than those lists cover — the `DDL`
 * template, the Neon `alters`, and the PGlite migration body's own `client.exec` calls.
 * "Created anywhere in the file" is the right question here: the failure this catches is a
 * declaration that disagrees with the SQL, not one backend having it and the other not.
 *
 * `CREATE` only — the file also carries a `DROP INDEX IF EXISTS` for the superseded
 * three-column embeddings index, which must not be read as a definition.
 */
function ddlUniqueIndexes(): Map<string, { table: string; columns: string[] }> {
  const found = new Map<string, { table: string; columns: string[] }>();
  const re =
    /CREATE\s+UNIQUE\s+INDEX\s+(?:CONCURRENTLY\s+)?(?:IF\s+NOT\s+EXISTS\s+)?([A-Za-z_]\w*)\s+ON\s+(\w+)\s*\(([^)]*)\)/gi;
  for (const [, name, table, columns] of src.matchAll(re)) {
    found.set(name, {
      table,
      columns: columns
        .split(",")
        .map((c) => c.trim().replace(/\s+(asc|desc)$/i, "").replace(/"/g, ""))
        .filter(Boolean),
    });
  }
  return found;
}

const ddlIndexes = ddlUniqueIndexes();

type IndexDrift = { table: string; name: string; problem: string };
const indexDrift: IndexDrift[] = [];
let indexesChecked = 0;

for (const value of Object.values(schema)) {
  if (!is(value, PgTable)) continue;
  const table = getTableConfig(value);
  for (const idx of table.indexes) {
    // Non-unique indexes are performance hints: a missing one is slow, not wrong, and the
    // DDL carries several the schema does not declare. Only the uniqueness contracts are
    // correctness-bearing, so only those are pinned.
    if (!idx.config.unique) continue;
    indexesChecked += 1;

    const declared = idx.config.columns.map(
      (c) => (c as { name?: string }).name ?? "<expression>"
    );
    // Drizzle permits an unnamed index; the DDL side is matched by name, so an anonymous
    // one cannot be mirrored at all and is reported rather than silently skipped.
    const name = idx.config.name;
    if (!name) {
      indexDrift.push({
        table: table.name,
        name: "<unnamed>",
        problem:
          `unique index on (${declared.join(", ")}) has no name, so it cannot be matched ` +
          `against the DDL — give it one`,
      });
      continue;
    }

    const inDdl = ddlIndexes.get(name);
    if (!inDdl) {
      indexDrift.push({
        table: table.name,
        name,
        problem:
          `declared on (${declared.join(", ")}) but no CREATE UNIQUE INDEX of that name ` +
          `exists in src/db/index.ts`,
      });
      continue;
    }
    if (inDdl.columns.join(",") !== declared.join(",")) {
      indexDrift.push({
        table: table.name,
        name,
        problem:
          `schema.ts declares (${declared.join(", ")}) but the DDL creates ` +
          `(${inDdl.columns.join(", ")})`,
      });
    }
  }
}

function has(map: ColumnSets, table: string, column: string) {
  return map.get(table)?.has(column) ?? false;
}

type Drift = { table: string; column: string; missingFrom: string[] };
const drift: Drift[] = [];
let checked = 0;

for (const value of Object.values(schema)) {
  // Skip relations, enums, and type-only exports — only pg tables carry columns.
  if (!is(value, PgTable)) continue;
  const table = getTableConfig(value);

  if (!created.has(table.name)) {
    drift.push({
      table: table.name,
      column: "*",
      missingFrom: ["no CREATE TABLE in DDL or SCALE_DDL"],
    });
    continue;
  }

  for (const column of table.columns) {
    const name = column.name;
    if (RUNTIME_MANAGED.has(`${table.name}.${name}`)) continue;
    checked += 1;

    // A column in a CREATE TABLE block is covered: any database old enough to predate
    // the column was still built by that same block. Drift is a column that appears in
    // neither the block nor the incremental list for a given backend.
    if (has(created, table.name, name) || has(scaleAlters, table.name, name)) continue;

    const missingFrom: string[] = [];
    if (!has(neonAlters, table.name, name)) missingFrom.push("Neon `alters`");
    if (!has(pgliteEnsured, table.name, name)) missingFrom.push("PGlite `ensureColumn`");
    if (missingFrom.length > 0) drift.push({ table: table.name, column: name, missingFrom });
  }
}

// ---------------------------------------------------------------- version

/** Every DDL statement, normalized, so formatting and comments do not move the hash. */
function ddlFingerprint(): string {
  const statements: string[] = [];

  for (const stmt of ddlTemplate.split(";")) {
    const s = stmt.trim();
    if (s) statements.push(s);
  }
  for (const text of [scaleDdl, alters, adminV2]) {
    for (const [, body] of text.matchAll(/`([^`]*)`/g)) statements.push(body);
  }
  for (const [, table, column, definition] of pgliteBody.matchAll(
    /ensureColumn\(\s*client,\s*"(\w+)",\s*"(\w+)",\s*"([^"]*)"/g
  )) {
    statements.push(`ensureColumn ${table} ${column} ${definition}`);
  }

  const normalized = statements
    .map((s) => s.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .sort();

  return crypto.createHash("sha256").update(normalized.join("\n")).digest("hex");
}

const schemaVersion = (() => {
  const m = src.match(/export const SCHEMA_VERSION = (\d+)/);
  if (!m) throw new Error("Could not locate `SCHEMA_VERSION` — update this guard.");
  return Number(m[1]);
})();

const fingerprint = ddlFingerprint();

if (process.argv.includes("--update")) {
  fs.writeFileSync(
    LOCK,
    JSON.stringify({ version: schemaVersion, fingerprint }, null, 2) + "\n"
  );
  console.log(`schema-ddl: lock updated to version ${schemaVersion} (${fingerprint.slice(0, 12)})`);
  process.exit(0);
}

type Lock = { version: number; fingerprint: string };
let lock: Lock | null = null;
try {
  lock = JSON.parse(fs.readFileSync(LOCK, "utf8")) as Lock;
} catch {
  lock = null;
}

// ---------------------------------------------------------------- report

console.log(
  `schema-ddl: checked ${checked} columns and ${indexesChecked} unique indexes across ` +
    `${created.size} tables (SCHEMA_VERSION ${schemaVersion})`
);

const problems: string[] = [];

if (indexDrift.length > 0) {
  const lines = [`${indexDrift.length} unique index(es) drifted from the bootstrap DDL:`, ""];
  for (const { table, name, problem } of indexDrift) {
    lines.push(`    ${table}.${name}`);
    lines.push(`        ${problem}`);
  }
  lines.push(
    "",
    "  A uniqueness key declared in schema.ts but not matched in the DDL is only inert",
    "  until someone runs `npm run db:push` or `db:generate` — drizzle.config.ts points at",
    "  schema.ts, so either would apply THIS key to whatever DATABASE_URL resolves to.",
    "  Make the declaration and every CREATE UNIQUE INDEX agree on name and columns."
  );
  problems.push(lines.join("\n"));
}

if (drift.length > 0) {
  const lines = [`${drift.length} column(s) drifted from the bootstrap DDL:`, ""];
  for (const { table, column, missingFrom } of drift) {
    lines.push(`    ${table}.${column}`);
    for (const where of missingFrom) lines.push(`        missing from: ${where}`);
  }
  lines.push(
    "",
    "  Add the missing ALTER TABLE ... ADD COLUMN IF NOT EXISTS / ensureColumn entries",
    "  to src/db/index.ts. Do not run `drizzle-kit push` to fix this."
  );
  problems.push(lines.join("\n"));
}

if (!lock) {
  problems.push(
    `no ${path.basename(LOCK)} — create it with:\n` +
      "        npx tsx scripts/smoke-schema-ddl.ts --update"
  );
} else if (lock.fingerprint !== fingerprint) {
  if (lock.version === schemaVersion) {
    problems.push(
      "DDL changed but SCHEMA_VERSION did not.\n\n" +
        `        recorded: version ${lock.version}  ${lock.fingerprint.slice(0, 12)}\n` +
        `        current:  version ${schemaVersion}  ${fingerprint.slice(0, 12)}\n\n` +
        "  getDb() skips the whole migration sweep when the version in schema_migrations\n" +
        "  already matches, so this DDL would never run on an instance that has already\n" +
        `  migrated. Bump SCHEMA_VERSION to ${schemaVersion + 1} in src/db/index.ts, then:\n` +
        "        npx tsx scripts/smoke-schema-ddl.ts --update"
    );
  } else {
    problems.push(
      `DDL and SCHEMA_VERSION both changed (${lock.version} -> ${schemaVersion}), ` +
        "but the lock is stale. Record it with:\n" +
        "        npx tsx scripts/smoke-schema-ddl.ts --update"
    );
  }
} else if (lock.version !== schemaVersion) {
  problems.push(
    `SCHEMA_VERSION changed (${lock.version} -> ${schemaVersion}) with no DDL change. ` +
      "If that bump was deliberate, record it with:\n" +
      "        npx tsx scripts/smoke-schema-ddl.ts --update"
  );
}

if (problems.length === 0) {
  console.log("  ok  every schema.ts column is covered by the bootstrap DDL");
  console.log("  ok  every schema.ts unique index matches the DDL by name and columns");
  console.log(`  ok  DDL matches the recorded fingerprint for version ${schemaVersion}`);
  process.exit(0);
}

for (const problem of problems) console.error(`\n  FAIL  ${problem}`);
console.error("");
process.exit(1);
