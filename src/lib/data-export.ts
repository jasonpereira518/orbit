import { sql, type SQL } from "drizzle-orm";
import { getDb, rowsOf } from "@/db";
import { billingEvents } from "@/db/schema";
import { DATA_CATEGORY_META, type DataCategory } from "@/lib/data-categories";
import { exportSourcesFor, ownRowsSource, type ExportSource } from "@/lib/user-data";

/**
 * "Download my data", built from the same registry as "delete my data" so the two cannot
 * disagree about what a category is. Streamed page by page: a large account's export is
 * many megabytes, past both the 4.5 MB serverless response limit for a buffered body and
 * the server-action body limit (`CAPTURE_BODY_SIZE_LIMIT`, 32 MB).
 */
const PAGE = 500;
const REDACTED_SUFFIX = /(_encrypted|token|secret|_hash)$/i;
const EXCLUDED = new Set(["embedding", "embedding_vector", "blob_url", "inline_data"]);
const ACCOUNT_SOURCES: ExportSource[] = [ownRowsSource(billingEvents)];

export type UserExport = {
  format: string;
  exportedAt: string;
  categories: Record<DataCategory, Record<string, Record<string, unknown>[]>>;
  account: Record<string, Record<string, unknown>[]>;
};

function isRedactedColumn(key: string): boolean {
  return REDACTED_SUFFIX.test(key) || EXCLUDED.has(key);
}

/** Credentials, hashes, vectors and raw bytes never leave. */
export function redactExportRow(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    if (isRedactedColumn(key)) continue;
    out[key] = value;
  }
  return out;
}

/** Page query per source, for sources whose `*` would carry a column the export drops. */
type PageOverrides = Map<ExportSource, ExportSource["page"]>;

/**
 * Every single-table source's live columns, in table order (`attnum`, which is what `*`
 * expands to — including runtime-managed columns like `embedding_vector` that `schema.ts`
 * does not know). Where redaction would drop a column, or the source swaps one for an
 * expression, the page names its columns instead of `*`: the same keys in the same order,
 * without reading multi-megabyte vectors and inline bytes only to throw them away. Any
 * failure here leaves every source on `*`, i.e. exactly the old query.
 */
async function resolvePageOverrides(sources: readonly ExportSource[]): Promise<PageOverrides> {
  const overrides: PageOverrides = new Map();
  const narrowable = sources.filter((s) => s.pageColumns);
  if (narrowable.length === 0) return overrides;
  const names = [...new Set(narrowable.map((s) => s.name))];
  let rows: { table_name: string; column_name: string }[];
  try {
    const db = await getDb();
    rows = rowsOf<{ table_name: string; column_name: string }>(
      await db.execute(sql`
        SELECT n.name AS table_name, a.attname AS column_name
        FROM unnest(ARRAY[${sql.join(names.map((name) => sql`${name}`), sql`, `)}]::text[]) AS n(name)
        JOIN pg_attribute a ON a.attrelid = to_regclass(quote_ident(n.name))
        WHERE a.attnum > 0 AND NOT a.attisdropped
        ORDER BY n.name, a.attnum`)
    );
  } catch {
    return overrides;
  }
  const columnsByTable = new Map<string, string[]>();
  for (const row of rows) {
    const list = columnsByTable.get(row.table_name) ?? [];
    list.push(String(row.column_name));
    columnsByTable.set(row.table_name, list);
  }
  for (const source of narrowable) {
    const all = columnsByTable.get(source.name);
    if (!all || all.length === 0) continue;
    const kept = all.filter((column) => !isRedactedColumn(column));
    const swapped = kept.some((column) => source.columnExpressions?.[column]);
    if (kept.length === 0 || (kept.length === all.length && !swapped)) continue;
    const columns: SQL = sql.join(
      kept.map((column) => {
        const expression = source.columnExpressions?.[column];
        return expression ? sql`${expression} AS ${sql.identifier(column)}` : sql.identifier(column);
      }),
      sql`, `
    );
    const pageColumns = source.pageColumns!;
    overrides.set(source, (userId, limit, offset) => pageColumns(columns, userId, limit, offset));
  }
  return overrides;
}

async function* datasetChunks(userId: string, source: ExportSource, overrides: PageOverrides): AsyncGenerator<string> {
  const db = await getDb();
  yield `${JSON.stringify(source.name)}:[`;
  let first = true;
  const page = overrides.get(source) ?? source.page;
  for (let offset = 0; ; offset += PAGE) {
    const rows = rowsOf<Record<string, unknown>>(await db.execute(page(userId, PAGE, offset)));
    for (const raw of rows) {
      const clean = redactExportRow(raw);
      yield `${first ? "" : ","}${JSON.stringify(source.transform ? source.transform(clean) : clean)}`;
      first = false;
    }
    if (rows.length < PAGE) break;
  }
  yield "]";
}

async function* groupChunks(userId: string, sources: readonly ExportSource[], overrides: PageOverrides): AsyncGenerator<string> {
  yield "{";
  for (const [i, source] of sources.entries()) {
    if (i > 0) yield ",";
    yield* datasetChunks(userId, source, overrides);
  }
  yield "}";
}

export async function* userExportChunks(userId: string, now = new Date()): AsyncGenerator<string> {
  yield `{"format":"orbit-export/2","exportedAt":${JSON.stringify(now.toISOString())},"categories":{`;
  const overrides = await resolvePageOverrides([...DATA_CATEGORY_META.flatMap(({ id }) => exportSourcesFor(id)), ...ACCOUNT_SOURCES]);
  for (const [i, { id }] of DATA_CATEGORY_META.entries()) {
    yield `${i > 0 ? "," : ""}${JSON.stringify(id)}:`;
    yield* groupChunks(userId, exportSourcesFor(id), overrides);
  }
  yield `},"account":`;
  yield* groupChunks(userId, ACCOUNT_SOURCES, overrides);
  yield "}";
}

export function userExportStream(userId: string): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const chunks = userExportChunks(userId);
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const next = await chunks.next();
      if (next.done) controller.close();
      else controller.enqueue(encoder.encode(next.value));
    },
    async cancel() {
      await chunks.return(undefined);
    },
  });
}

export async function collectUserExport(userId: string): Promise<UserExport> {
  let text = "";
  for await (const chunk of userExportChunks(userId)) text += chunk;
  return JSON.parse(text) as UserExport;
}
