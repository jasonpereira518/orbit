/**
 * The shape of an import id, checked before it reaches a query.
 *
 * `imports.id` and `import_job_rows.import_id` are uuid columns. An id that is not a uuid —
 * hand-typed into `/contacts?importId=`, or forged in a server-action call — fails Postgres's
 * cast (22P02) and turns a read into an error, where "there is no such import" was the true
 * answer. So every place an import id enters a query goes through here first: the People
 * list's filter, and every action in `src/actions/imports.ts` that takes one.
 *
 * Pure and import-free on purpose — `src/actions/imports.ts` is a "use server" file and may
 * export only async functions, so a shared constant cannot live there.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isImportId(value: unknown): value is string {
  return typeof value === "string" && UUID.test(value);
}

/** The usable ids from a list, trimmed, each once, in the order given. */
export function importIdsFrom(values: readonly unknown[]): string[] {
  const out: string[] = [];
  for (const value of values) {
    const id = typeof value === "string" ? value.trim() : value;
    if (isImportId(id) && !out.includes(id)) out.push(id);
  }
  return out;
}
