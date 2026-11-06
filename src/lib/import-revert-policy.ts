/**
 * The pure half of import reverts: what may be undone, why one was refused, and how to say
 * what an undo did.
 *
 * Split from `@/lib/import-revert` for the same reason `@/lib/dates` is split from
 * `suggested-reminder-utils`: that module opens the database, so it cannot be pulled into a
 * client component — and the import history row, which is a client component, has to decide
 * whether to render an Undo button at all. Nothing here touches a database or a request.
 */
import type { ImportRevertStats } from "@/db/schema";

export type RevertRefusal =
  | "not_found"
  | "still_running"
  | "already_reverted"
  | "not_revertible";

/** Human-readable reason a revert was refused, for the toast and the action's result. */
export const REVERT_REFUSAL_MESSAGE: Record<RevertRefusal, string> = {
  not_found: "That import no longer exists.",
  still_running: "This import is still running. Cancel it first, then undo it.",
  already_reverted: "This import has already been undone.",
  not_revertible:
    "This import ran before Orbit started recording what it created, so it cannot be undone automatically.",
};

/**
 * Whether an import has *finished in a state that can be undone* — the half of the question
 * that the `imports` row alone can answer.
 *
 * A job still `pending` or `processing` is excluded because its rows are mid-flight:
 * reverting underneath a running engine would delete contacts it is about to write
 * interactions against. A `failed` or `cancelled` job IS revertible, and deliberately so — a
 * half-finished import is the most likely one a person wants to take back.
 *
 * The vocabulary is the engine's, not a guess: `completed` (not "done" — that is the
 * `import_job_rows` word for a single row, and the two tables do not share a spelling),
 * `failed`, `cancelled`, `processing`, `pending`.
 *
 * This is necessary but not sufficient. The other half is whether the job's rows recorded
 * create-vs-merge at all, which lives in `import_job_rows` and so must be answered by a
 * query — see `listImports`. Both are required before the button is offered.
 */
const TERMINAL_IMPORT_STATUSES = ["completed", "failed", "cancelled"];

export function hasRevertibleStatus(row: {
  status: string;
  revertedAt?: Date | string | null;
}): boolean {
  if (row.revertedAt) return false;
  return TERMINAL_IMPORT_STATUSES.includes(row.status);
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** One line summarising what a revert did, for the toast. */
export function describeRevert(stats: ImportRevertStats): string {
  const parts: string[] = [];
  if (stats.contactsDeleted)
    parts.push(`${plural(stats.contactsDeleted, "contact", "contacts")} removed`);
  if (stats.mergesReverted)
    parts.push(`${plural(stats.mergesReverted, "merge", "merges")} rolled back`);
  if (stats.interactionsDeleted)
    parts.push(`${plural(stats.interactionsDeleted, "interaction", "interactions")} removed`);
  if (stats.remindersDeleted)
    parts.push(`${plural(stats.remindersDeleted, "reminder", "reminders")} removed`);

  // Never omitted when non-zero: "12 contacts removed" alone would read as a total undo.
  const kept = (stats.contactsKept ?? 0) + (stats.mergesKept ?? 0);
  if (kept > 0) parts.push(`${kept} kept because you edited them since`);
  if (stats.rowsUnknown)
    parts.push(`${plural(stats.rowsUnknown, "row", "rows")} could not be traced`);

  return parts.length > 0 ? parts.join(" · ") : "Nothing left to undo";
}
