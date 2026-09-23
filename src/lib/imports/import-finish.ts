/**
 * The done card's words.
 *
 * Pure, and the single source of the finish's arithmetic: the card, the history chips and the
 * People list all describe the same import, and they have disagreed before — the engine counts
 * every merged person under both `contactsUpdated` and `duplicatesFound`, which once rendered
 * as "2 updated · 2 already here" for two people. The counts arrive here already reconciled;
 * this module only chooses the words.
 */
/**
 * How long an import can be undone for.
 *
 * It lives here, in the finish's pure module, rather than beside the undo itself: the history
 * sheet has to decide whether to offer the button or explain that the window has closed, and
 * it is a client component — `import-undo.ts` reaches `@/db`, so importing anything runtime
 * from it there fails the build with a `node:fs` chunk error. `import-undo.ts` re-exports this
 * so the server side keeps its own name for it and there is still only one 7.
 */
export const UNDO_WINDOW_DAYS = 7;

/** True while `createdAt` is still inside the undo window. */
export function withinUndoWindow(createdAt: Date, now: Date = new Date()): boolean {
  return now.getTime() - createdAt.getTime() <= UNDO_WINDOW_DAYS * 86_400_000;
}

export type FinishSummary = {
  importId: string;
  /** People the import brought into Orbit. */
  added: number;
  /** People it matched to someone already here. */
  existing: number;
  meetingsLogged: number;
  /** File names or connection labels, in the order they ran. */
  sources: string[];
  /** Set when a step didn't finish — the card leads with this instead of celebrating. */
  unfinished?: string;
};

export type FinishCopy = {
  headline: string;
  detail: string | null;
  action: { label: string; href: string } | { label: string; kind: "detail" };
};

const people = (n: number) => `${n} ${n === 1 ? "person" : "people"}`;

export function finishCopy(summary: FinishSummary): FinishCopy {
  const { added, existing, meetingsLogged, sources, importId, unfinished } = summary;

  const headline = unfinished
    ? unfinished
    : added > 0
      ? `You added ${people(added)}`
      : meetingsLogged > 0
        ? `${meetingsLogged} meeting${meetingsLogged === 1 ? "" : "s"} logged`
        : existing > 0
          ? "Everyone here already"
          : "Nothing new this time";

  const parts: string[] = [];
  if (existing > 0 && added > 0) parts.push(`${people(existing)} were already in your orbit`);
  else if (existing > 0) parts.push(`${people(existing)} matched someone you already had`);
  if (sources.length > 1) parts.push(`From ${sources.join(" and ")}`);
  const detail = parts.length ? parts.join(" — ") : null;

  const action =
    added > 0
      ? { label: `Meet your ${people(added)}`, href: `/contacts?importId=${importId}` }
      : { label: "See what changed", kind: "detail" as const };

  return { headline, detail, action };
}