/**
 * The run summary's shape and copy. No database import: client components render from it.
 */
import type { RelationshipRunFlag, RelationshipRunStatus } from "@/db/schema";

export type RunSummaryReminder = { id: string; title: string; dueIso: string | null; contactId: string | null; contactName: string | null; status: string };
export type RunSummaryFlag = RelationshipRunFlag & { contactName: string };
export type RunSummary = {
  id: string;
  importId: string | null;
  status: RelationshipRunStatus;
  processed: number;
  skipped: number;
  failed: number;
  remindersCreated: number;
  openThreadsAdded: number;
  factsAdded: number;
  /** Pending contacts; 0 unless the run is active. */
  remaining: number;
  /** The run batch's reminders, latest due first, max 20. */
  reminders: RunSummaryReminder[];
  flags: RunSummaryFlag[];
  /** Digests of this run with history_truncated_before set. */
  truncatedPeople: number;
  /** attempts >= 3 since the run began, max 5. */
  parkedPeople: Array<{ contactId: string; name: string }>;
  createdAt: string;
  finishedAt: string | null;
  /** status done|failed and it has a note batch. */
  undoable: boolean;
};
export type RunSummaryCopy = { headline: string; progress: string | null; notes: string[] };

const people = (n: number) => `${n} ${n === 1 ? "person" : "people"}`;
const count = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

export function runSummaryCopy(s: RunSummary): RunSummaryCopy {
  const parts = [`Analyzed ${people(s.processed)}`, count(s.remindersCreated, "reminder"), count(s.openThreadsAdded, "open thread")];
  if (s.skipped) parts.push(`${s.skipped} skipped (too short)`);
  const total = s.processed + s.remaining;
  const progress =
    s.status === "waiting_key"
      ? `Add an AI key to analyze ${s.remaining} more ${s.remaining === 1 ? "person" : "people"}`
      : s.status === "queued" || s.status === "running"
        ? `Analyzing ${s.processed} of ${total} — the rest within a few hours`
        : null;
  const notes: string[] = [];
  if (s.failed) notes.push(`Couldn’t analyze ${people(s.failed)}`);
  if (s.truncatedPeople) notes.push(`Older history not read for ${people(s.truncatedPeople)}`);
  if (s.status === "undone") notes.push("Undone — its reminders were removed");
  return { headline: parts.join(" · "), progress, notes };
}
