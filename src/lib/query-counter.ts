/**
 * Process-local count of SQL statements issued.
 *
 * On `neon-http` every statement is a separate HTTPS request, so this number is the
 * closest thing Orbit has to a wall-clock predictor for bulk work — and the only way to
 * catch a re-introduced per-row `await`, which is how the import path got slow in the
 * first place. Deliberately an exact counter and not a sampler: the guard asserts a
 * budget, and an approximate number would be worse than none.
 */
let active = false;
let count = 0;

export function startQueryCount() {
  active = true;
  count = 0;
}

export function stopQueryCount() {
  active = false;
  return count;
}

/** Called by the Drizzle logger wired up in `src/db/index.ts`. */
export function noteQuery() {
  if (active) count += 1;
}
