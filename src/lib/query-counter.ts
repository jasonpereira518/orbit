/**
 * Process-local count of SQL statements issued.
 *
 * On `neon-http` every statement is a separate HTTPS request, so this number is the
 * closest thing Orbit has to a wall-clock predictor for bulk work — and the only way to
 * catch a re-introduced per-row `await`, which is how the import path got slow in the
 * first place. Deliberately an exact counter and not a sampler: the guard asserts a
 * budget, and an approximate number would be worse than none.
 *
 * The statement text is captured too, for the same reason: a hot path that is slow
 * because of row WIDTH (pulling `notes` or a base64 avatar for every contact) issues
 * exactly the same number of statements as a fast one. `scripts/smoke-page-budgets.ts`
 * asserts on which columns the scans select.
 */
let active = false;
let count = 0;
let captured: string[] = [];

export function startQueryCount() {
  active = true;
  count = 0;
  captured = [];
}

export function stopQueryCount() {
  active = false;
  return count;
}

/** Statement text seen since `startQueryCount()`, in order. */
export function capturedQueries(): string[] {
  return [...captured];
}

/** Called by the Drizzle logger wired up in `src/db/index.ts`. */
export function noteQuery(query?: string) {
  if (!active) return;
  count += 1;
  if (query) captured.push(query);
}
