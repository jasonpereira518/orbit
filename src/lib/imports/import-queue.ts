/**
 * One drop, several files, run in order.
 *
 * The runner allows exactly one server-owned import in flight per user — `startImportJob`
 * throws if you try for two — and that guard is load-bearing: the resumption paths
 * (`/api/imports/[id]/continue`, the process-stalled cron) all assume it. So dropping a
 * LinkedIn archive, which is two imports, cannot mean making the runner multi-job. It means a
 * queue on top of it, and this is the part of that queue with no React, no fetch and no DOM in
 * it, so its ordering and its failure rules can be tested directly.
 *
 * ## Two rules worth stating
 *
 * A failed step does not stop the queue. If the messages import breaks, the calendar should
 * still land — the alternative punishes someone for dropping more than one file at a time.
 *
 * `error` is always already-friendly text. Callers run `friendlyError` at the moment they
 * catch, not when they render, so there is no path by which a Postgres or OAuth body reaches
 * the summary line.
 */
import {
  RUN_ORDER,
  type Detected,
  type ImportTarget,
} from "@/lib/imports/detect-import-file";

export type QueuedImportStatus =
  | "waiting"
  | "previewing"
  | "needs_review"
  | "running"
  | "done"
  | "failed"
  | "skipped";

export type QueuedImport = {
  /** Stable across re-renders. Never a filename — two files can share one. */
  id: string;
  target: ImportTarget;
  /** What this is, in the person's words. */
  label: string;
  fileName: string;
  status: QueuedImportStatus;
  /** Rows the person kept in review. */
  ids?: string[];
  reviewCount?: number;
  /** Already through `friendlyError`. Never raw. */
  error?: string;
  /** The runner's own completion line. */
  result?: string;
};

export type ImportQueueSnapshot = {
  items: QueuedImport[];
  /** Index into `items` of the step running now, or -1. */
  activeIndex: number;
  /** 1-based, counting only steps that will actually run. Null when nothing is running. */
  step: { index: number; total: number } | null;
  /** Every item has reached a terminal state. */
  done: boolean;
};

/** What each target is called on screen. */
export const TARGET_LABEL: Record<Exclude<ImportTarget, "unknown">, string> = {
  linkedin_connections: "LinkedIn connections",
  linkedin_messages: "LinkedIn messages",
  contacts_file: "Contacts",
  calendar_ics: "Calendar",
  calendar_csv: "Calendar",
};

/**
 * The same names inside a sentence.
 *
 * Lowercasing `TARGET_LABEL` is not good enough: it turns LinkedIn into "linkedin", and
 * LinkedIn is a proper noun wherever it appears.
 */
export const TARGET_LABEL_INLINE: Record<
  Exclude<ImportTarget, "unknown">,
  string
> = {
  linkedin_connections: "LinkedIn connections",
  linkedin_messages: "LinkedIn messages",
  contacts_file: "contacts",
  calendar_ics: "calendar",
  calendar_csv: "calendar",
};

const TERMINAL: readonly QueuedImportStatus[] = ["done", "failed", "skipped"];

export function isTerminal(status: QueuedImportStatus): boolean {
  return TERMINAL.includes(status);
}

/** Build the queue from a detection result, in run order. */
export function queueFromDetection(
  staged: readonly Detected[],
): QueuedImport[] {
  return [...staged]
    .sort((a, b) => RUN_ORDER.indexOf(a.target) - RUN_ORDER.indexOf(b.target))
    .map((d, i) => ({
      id: `q${i}-${d.target}`,
      target: d.target,
      label:
        TARGET_LABEL[d.target as Exclude<ImportTarget, "unknown">] ?? "Import",
      fileName: d.displayName,
      status: "waiting" as const,
    }));
}

/**
 * The next item to import: reviewed, and nothing ahead of it still going.
 *
 * Returns null while a step is in flight, which is what serialises the run without the caller
 * needing a lock of its own.
 */
export function nextRunnable(
  items: readonly QueuedImport[],
): QueuedImport | null {
  if (items.some((i) => i.status === "running")) return null;
  return (
    items.find(
      (i) => i.status === "needs_review" && (i.ids?.length ?? 0) > 0,
    ) ?? null
  );
}

/** Replace one item, by id. */
export function advance(
  items: readonly QueuedImport[],
  id: string,
  patch: Partial<QueuedImport>,
): QueuedImport[] {
  return items.map((i) => (i.id === id ? { ...i, ...patch } : i));
}

/**
 * Stop: whatever is running is cancelled by the caller, and nothing that has not started will.
 *
 * Items already done keep their result — the rows they imported are kept server-side, so
 * saying otherwise in the summary would be a lie.
 */
export function stopAll(items: readonly QueuedImport[]): QueuedImport[] {
  return items.map((i) =>
    i.status === "waiting" ||
    i.status === "needs_review" ||
    i.status === "previewing"
      ? { ...i, status: "skipped" as const }
      : i,
  );
}

export function summarize(items: readonly QueuedImport[]): ImportQueueSnapshot {
  const activeIndex = items.findIndex((i) => i.status === "running");
  // Skipped steps are excluded from the count so "step 2 of 3" cannot describe a run whose
  // third step was never going to happen.
  const counted = items.filter((i) => i.status !== "skipped");
  const active = activeIndex >= 0 ? items[activeIndex] : null;
  const step = active
    ? {
        index: counted.findIndex((i) => i.id === active.id) + 1,
        total: counted.length,
      }
    : null;
  return {
    items: [...items],
    activeIndex,
    step,
    done: items.length > 0 && items.every((i) => isTerminal(i.status)),
  };
}

/**
 * The single line shown when the whole queue ends.
 *
 * One message rather than one per step: three files dropped at once used to mean three toasts.
 * House voice — no "failed", no trailing period, " — " as the one connector.
 */
export function summaryMessage(items: readonly QueuedImport[]): string {
  const done = items.filter((i) => i.status === "done");
  const failed = items.filter((i) => i.status === "failed");
  const skipped = items.filter((i) => i.status === "skipped");

  const names = (list: readonly QueuedImport[]) => {
    const labels = list.map(
      (i) =>
        TARGET_LABEL_INLINE[i.target as Exclude<ImportTarget, "unknown">] ??
        i.label,
    );
    if (labels.length === 1) return labels[0];
    if (labels.length === 2) return `${labels[0]} and ${labels[1]}`;
    return `${labels.slice(0, -1).join(", ")} and ${labels[labels.length - 1]}`;
  };

  if (done.length && !failed.length && !skipped.length) {
    return `Imported your ${names(done)}`;
  }
  if (done.length && failed.length) {
    return `Imported your ${names(done)} — your ${names(failed)} didn’t finish, so try that file on its own`;
  }
  if (done.length && skipped.length) {
    return `Imported your ${names(done)} — the rest was stopped`;
  }
  if (failed.length) {
    return `Your ${names(failed)} didn’t finish — try that file on its own`;
  }
  return "Nothing was imported";
}
