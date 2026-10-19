import { sql, type SQL } from "drizzle-orm";
import { getDb, rowsOf } from "@/db";
import { billingEvents, creditAccounts, creditGrants, creditHolds, planMeterUsage } from "@/db/schema";
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
// `ics_url` is a calendar's secret address: read access to it, so a credential like the rest.
const EXCLUDED = new Set(["embedding", "embedding_vector", "blob_url", "inline_data", "ics_url"]);
/** A page of a query keyed on the account's mirrored email (the waitlist predates the account). */
const byEmail = (name: string, query: (email: SQL, limit: number, offset: number) => SQL): ExportSource => ({
  name,
  page: (userId, limit, offset) =>
    query(sql`(SELECT lower(email) FROM user_settings WHERE user_id = ${userId})`, limit, offset),
});

/**
 * The account itself: billing, the credit ledger, and records about this account that live
 * outside its own tables — the waitlist entry and broadcasts it received (by email), what the
 * operator did to the account, and the account events Clerk sent. Operator ids, free-text
 * reasons and raw webhook payloads stay out: those are the operator's records, and what they
 * hold about the account is the action and when (⚖️ PRIVACY_PLAN.md §6 on audit entries).
 */
const ACCOUNT_SOURCES: ExportSource[] = [
  ownRowsSource(billingEvents),
  ownRowsSource(creditAccounts, "user_id"),
  ownRowsSource(creditGrants),
  ownRowsSource(creditHolds),
  ownRowsSource(planMeterUsage),
  byEmail("interest_list_signups", (email, limit, offset) => sql`
    SELECT id, email, first_name, last_name, referrer, utm_source, utm_medium, utm_campaign, landing_path,
           welcome_planet, referral_slug, signup_event_label, unsubscribed_at, created_at
      FROM interest_list_signups WHERE lower(email) = ${email} ORDER BY id LIMIT ${limit} OFFSET ${offset}`),
  byEmail("broadcasts_received", (email, limit, offset) => sql`
    SELECT r.id, b.subject, r.sent_at, r.created_at
      FROM broadcast_recipients r LEFT JOIN broadcasts b ON b.id = r.broadcast_id
     WHERE lower(r.email) = ${email} ORDER BY r.id LIMIT ${limit} OFFSET ${offset}`),
  {
    name: "operator_actions_on_account",
    page: (userId, limit, offset) => sql`
      SELECT id, action, resource_type, created_at FROM admin_audit_log
       WHERE target_user_id = ${userId} ORDER BY id LIMIT ${limit} OFFSET ${offset}`,
  },
  {
    name: "account_events",
    page: (userId, limit, offset) => sql`
      SELECT id, source, event_type, outcome, created_at FROM webhook_deliveries
       WHERE target_user_id = ${userId} ORDER BY id LIMIT ${limit} OFFSET ${offset}`,
  },
];

export type UserExport = {
  format: string;
  exportedAt: string;
  categories: Record<DataCategory, Record<string, Record<string, unknown>[]>>;
  account: Record<string, Record<string, unknown>[]>;
  /** Present (true) only when the whole file was written. */
  complete: true;
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
  // v3: the account section gained the credit ledger and the records found by email, and
  // the file ends with `"complete":true`.
  yield `{"format":"orbit-export/3","exportedAt":${JSON.stringify(now.toISOString())},"categories":{`;
  const overrides = await resolvePageOverrides([...DATA_CATEGORY_META.flatMap(({ id }) => exportSourcesFor(id)), ...ACCOUNT_SOURCES]);
  for (const [i, { id }] of DATA_CATEGORY_META.entries()) {
    yield `${i > 0 ? "," : ""}${JSON.stringify(id)}:`;
    yield* groupChunks(userId, exportSourcesFor(id), overrides);
  }
  yield `},"account":`;
  yield* groupChunks(userId, ACCOUNT_SOURCES, overrides);
  // Last, on purpose: a download the platform cut short (the route's 300 s limit) is already
  // invalid JSON, but a tolerant reader — or a person — can tell it is incomplete by its absence.
  yield `,"complete":true}`;
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
