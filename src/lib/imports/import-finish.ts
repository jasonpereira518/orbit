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
  /**
   * Every import this card speaks for, in the order they ran.
   *
   * A list rather than one id because one drop is one card and each file in it writes its own
   * `imports` row: a LinkedIn archive is connections *and* messages, and a card that read one
   * row would either undercount the people or link to a fraction of them. The button carries
   * all of them, which is why `/contacts?importId=` takes a comma-separated list.
   */
  importIds: string[];
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

/**
 * One drop, one card.
 *
 * The run's steps each finished their own import, and this is where they become a single
 * sentence: counts sum, sources keep the order they ran in, and every import id is carried so
 * the button can point at all of the people rather than at one file's share of them.
 *
 * **Null when nothing finished**, and that is the load-bearing part rather than an edge case.
 * The card used to be drawn from "the newest completed import on the account", which meant a
 * drop of files Orbit could not read, or a run whose every step broke, still celebrated some
 * unrelated import from last week and offered a button into its people. A run with no finished
 * import has no summary, so there is nothing to draw.
 */
export function mergeFinishSummaries(
  parts: readonly FinishSummary[],
  unfinished?: string,
): FinishSummary | null {
  if (!parts.length) return null;
  return {
    importIds: parts.flatMap((p) => p.importIds),
    added: parts.reduce((n, p) => n + p.added, 0),
    existing: parts.reduce((n, p) => n + p.existing, 0),
    meetingsLogged: parts.reduce((n, p) => n + p.meetingsLogged, 0),
    sources: parts.flatMap((p) => p.sources),
    ...(unfinished ? { unfinished } : {}),
  };
}

export function finishCopy(summary: FinishSummary): FinishCopy {
  const { added, existing, meetingsLogged, sources, importIds, unfinished } = summary;

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
      ? {
          // "new", as the spec wrote it: the list this opens holds exactly the people the
          // run added, never the ones it matched (`contacts-page-query.ts`).
          label: `Meet your ${added} new ${added === 1 ? "person" : "people"}`,
          // Comma-separated, and `contacts-page-query.ts` splits it back apart: the label
          // promises every person the run added, so the list it opens has to hold them all.
          href: `/contacts?importId=${importIds.join(",")}`,
        }
      : { label: "See what changed", kind: "detail" as const };

  return { headline, detail, action };
}