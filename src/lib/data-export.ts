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

/** Credentials, hashes, vectors and raw bytes never leave. */
export function redactExportRow(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    if (REDACTED_SUFFIX.test(key) || EXCLUDED.has(key)) continue;
    out[key] = value;
  }
  return out;
}

async function* datasetChunks(userId: string, source: ExportSource): AsyncGenerator<string> {
  const db = await getDb();
  yield `${JSON.stringify(source.name)}:[`;
  let first = true;
  for (let offset = 0; ; offset += PAGE) {
    const rows = rowsOf<Record<string, unknown>>(await db.execute(source.page(userId, PAGE, offset)));
    for (const raw of rows) {
      const clean = redactExportRow(raw);
      yield `${first ? "" : ","}${JSON.stringify(source.transform ? source.transform(clean) : clean)}`;
      first = false;
    }
    if (rows.length < PAGE) break;
  }
  yield "]";
}

async function* groupChunks(userId: string, sources: readonly ExportSource[]): AsyncGenerator<string> {
  yield "{";
  for (const [i, source] of sources.entries()) {
    if (i > 0) yield ",";
    yield* datasetChunks(userId, source);
  }
  yield "}";
}

export async function* userExportChunks(userId: string, now = new Date()): AsyncGenerator<string> {
  yield `{"format":"orbit-export/2","exportedAt":${JSON.stringify(now.toISOString())},"categories":{`;
  for (const [i, { id }] of DATA_CATEGORY_META.entries()) {
    yield `${i > 0 ? "," : ""}${JSON.stringify(id)}:`;
    yield* groupChunks(userId, exportSourcesFor(id));
  }
  yield `},"account":`;
  yield* groupChunks(userId, ACCOUNT_SOURCES);
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
