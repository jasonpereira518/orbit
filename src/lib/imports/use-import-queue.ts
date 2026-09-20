"use client";

import { useSyncExternalStore } from "react";
import {
  previewCalendarImport,
  previewContactsFile,
  previewLinkedInCsv,
  previewLinkedInMessagesCsv,
} from "@/actions/imports";
import { friendlyError, UserFacingError } from "@/lib/errors";
import {
  awaitImportJob,
  markQueuedImportJob,
  startImportJob,
  cancelImportJob,
  type ImportJobInput,
  type ImportJobKind,
} from "@/lib/import-job-runner";
import type { ReviewPerson } from "@/components/imports/import-people-review";
import {
  connectionToReviewPerson,
  contactsFileToReviewPerson,
  messageThreadToReviewPerson,
} from "@/lib/imports/review-people";
import {
  advance,
  nextRunnable,
  queueFromDetection,
  stopAll,
  summarize,
  summaryMessage,
  type ImportQueueSnapshot,
  type QueuedImport,
} from "@/lib/imports/import-queue";
import type {
  Detected,
  DetectionResult,
  ImportTarget,
} from "@/lib/imports/detect-import-file";
import { IMPORT_COPY } from "@/lib/imports/import-copy";

/**
 * The store and driver behind a multi-file drop.
 *
 * Shaped like `import-job-runner.ts` — a module-level singleton read through
 * `useSyncExternalStore` — for the same reason it is: the queue has to outlive any one
 * component, so that closing a panel or navigating within the page cannot orphan a run.
 *
 * The reducer next door holds every decision worth testing; this file holds the effects.
 */

/**
 * The single bridge between the detection vocabulary (which aliases `imports.import_type`) and
 * the runner's shorter one. Two vocabularies with one crossing, rather than three.
 */
const KIND_FOR_TARGET: Record<
  Exclude<ImportTarget, "unknown">,
  ImportJobKind
> = {
  linkedin_connections: "connections",
  linkedin_messages: "messages",
  contacts_file: "contacts_file",
  calendar_ics: "calendar",
  calendar_csv: "calendar",
};

/** Previews are read-only server actions, so a couple at a time is safe and keeps the first
 * section reviewable while the rest load. Matches the capture fan-out's own ceiling. */
const PREVIEW_CONCURRENCY = 2;

type QueueState = {
  items: QueuedImport[];
  /** Raw text per item id, held until the confirm action re-parses it server-side. */
  payloads: Map<
    string,
    { text: string; fileName: string; target: ImportTarget }
  >;
  people: Map<string, ReviewPerson[]>;
  /** Files the drop could not use, for the "Not imported" list. */
  ignored: { name: string; reason: string }[];
  truncated: boolean;
  phase: "idle" | "previewing" | "review" | "running" | "done";
  /** Set while the whole queue is being torn down by the Stop button. */
  stopping: boolean;
};

const EMPTY: QueueState = {
  items: [],
  payloads: new Map(),
  people: new Map(),
  ignored: [],
  truncated: false,
  phase: "idle",
  stopping: false,
};

let state: QueueState = EMPTY;
const listeners = new Set<() => void>();

function emit() {
  for (const l of listeners) l();
}

function setState(next: Partial<QueueState>) {
  state = { ...state, ...next };
  emit();
}

export function subscribeImportQueue(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getImportQueueState() {
  return state;
}

export function clearImportQueue() {
  state = { ...EMPTY, payloads: new Map(), people: new Map() };
  emit();
}

export type ImportQueueView = ImportQueueSnapshot & {
  people: Map<string, ReviewPerson[]>;
  ignored: { name: string; reason: string }[];
  truncated: boolean;
  phase: QueueState["phase"];
  stopping: boolean;
};

export function useImportQueue(): ImportQueueView {
  const snap = useSyncExternalStore(
    subscribeImportQueue,
    getImportQueueState,
    () => EMPTY,
  );
  return {
    ...summarize(snap.items),
    people: snap.people,
    ignored: snap.ignored,
    truncated: snap.truncated,
    phase: snap.phase,
    stopping: snap.stopping,
  };
}

// ------------------------------------------------------------------------------- previewing

async function readText(d: Detected): Promise<string> {
  // ZIP members were decompressed to be identified; re-reading the archive would be wasted
  // work, and a `File` cannot be recovered from a ZIP entry anyway.
  return d.text ?? (await d.file.text());
}

type PreviewOutcome =
  | {
      ok: true;
      people: ReviewPerson[];
      ids: string[];
      text: string;
      fileName: string;
    }
  | { ok: false; error: string };

async function previewOne(d: Detected): Promise<PreviewOutcome> {
  const fileName = d.path
    ? (d.path.split("/").pop() ?? d.file.name)
    : d.file.name;
  try {
    const text = await readText(d);

    if (d.target === "linkedin_connections") {
      const res = await previewLinkedInCsv(text);
      if ("error" in res) throw new UserFacingError(res.error);
      const people = res.people.map(connectionToReviewPerson);
      return { ok: true, people, ids: unrepeated(people), text, fileName };
    }
    if (d.target === "linkedin_messages") {
      const res = await previewLinkedInMessagesCsv(text);
      if ("error" in res) throw new UserFacingError(res.error);
      const people = res.people.map(messageThreadToReviewPerson);
      return { ok: true, people, ids: unrepeated(people), text, fileName };
    }
    if (d.target === "contacts_file") {
      const res = await previewContactsFile(text, fileName);
      if ("error" in res) throw new UserFacingError(res.error);
      const people = res.people.map(contactsFileToReviewPerson);
      return { ok: true, people, ids: unrepeated(people), text, fileName };
    }
    // Calendar has no per-person review — a whole file is confirmed at once — so its "ids" is
    // a single sentinel, which is also what makes it runnable in the reducer.
    const res = await previewCalendarImport({
      kind: d.target === "calendar_ics" ? "ics" : "csv",
      text,
    });
    if ("error" in res)
      throw new UserFacingError((res as { error: string }).error);
    return { ok: true, people: [], ids: ["calendar"], text, fileName };
  } catch (err) {
    return { ok: false, error: friendlyError(err, IMPORT_COPY.previewFailed) };
  }
}

/** Everyone the engine does not already have, which is what each card pre-selects today. */
function unrepeated(people: ReviewPerson[]): string[] {
  return people.filter((p) => !p.isRepeat).map((p) => p.id);
}

/**
 * Stage a drop: build the queue, then preview everything so one review screen can cover it.
 */
export async function stageDrop(result: DetectionResult): Promise<void> {
  const items = queueFromDetection(result.staged);
  const payloads = new Map<
    string,
    { text: string; fileName: string; target: ImportTarget }
  >();
  const people = new Map<string, ReviewPerson[]>();

  setState({
    items,
    payloads,
    people,
    ignored: [...result.ignored, ...result.skipped].map((d) => ({
      name: d.path ? (d.path.split("/").pop() ?? d.file.name) : d.file.name,
      reason: d.reason,
    })),
    truncated: result.truncated,
    phase: items.length ? "previewing" : "done",
    stopping: false,
  });
  if (!items.length) return;

  const byId = new Map(
    items.map(
      (item, i) => [item.id, result.staged.slice().sort(orderOf)[i]] as const,
    ),
  );

  let cursor = 0;
  const workers = Array.from(
    { length: Math.min(PREVIEW_CONCURRENCY, items.length) },
    async () => {
      for (;;) {
        const index = cursor++;
        if (index >= items.length) return;
        const item = items[index];
        const source = byId.get(item.id);
        if (!source) continue;

        setState({
          items: advance(state.items, item.id, { status: "previewing" }),
        });
        const outcome = await previewOne(source);
        if (!outcome.ok) {
          setState({
            items: advance(state.items, item.id, {
              status: "failed",
              error: outcome.error,
            }),
          });
          continue;
        }
        state.payloads.set(item.id, {
          text: outcome.text,
          fileName: outcome.fileName,
          target: source.target,
        });
        state.people.set(item.id, outcome.people);
        setState({
          items: advance(state.items, item.id, {
            status: "needs_review",
            ids: outcome.ids,
            reviewCount: outcome.people.length,
          }),
        });
      }
    },
  );

  await Promise.all(workers);
  setState({
    phase: state.items.some((i) => i.status === "needs_review")
      ? "review"
      : "done",
  });
}

function orderOf(a: Detected, b: Detected) {
  return (
    [
      "linkedin_connections",
      "contacts_file",
      "linkedin_messages",
      "calendar_ics",
      "calendar_csv",
    ].indexOf(a.target) -
    [
      "linkedin_connections",
      "contacts_file",
      "linkedin_messages",
      "calendar_ics",
      "calendar_csv",
    ].indexOf(b.target)
  );
}

/** Change which people a step will import. */
export function setSelection(itemId: string, ids: string[]) {
  setState({ items: advance(state.items, itemId, { ids }) });
}

/** Drop a step from the run without touching the others. */
export function skipItem(itemId: string) {
  setState({ items: advance(state.items, itemId, { status: "skipped" }) });
}

// ---------------------------------------------------------------------------------- running

function inputFor(item: QueuedImport): ImportJobInput | null {
  const payload = state.payloads.get(item.id);
  if (!payload) return null;
  const ids = item.ids ?? [];

  // Through the one map, not a second switch over targets — the whole point of having it.
  const kind =
    KIND_FOR_TARGET[payload.target as Exclude<ImportTarget, "unknown">];
  switch (kind) {
    case "connections":
    case "messages":
      return { kind, csvText: payload.text, fileName: payload.fileName, ids };
    case "contacts_file":
      return { kind, text: payload.text, fileName: payload.fileName, ids };
    case "calendar":
      return {
        kind,
        calendarKind: payload.target === "calendar_ics" ? "ics" : "csv",
        text: payload.text,
        fileName: payload.fileName,
        createFollowUps: false,
      };
    default:
      return null;
  }
}

export type RunResult = { message: string };

/**
 * Run every reviewed step, one after another.
 *
 * Each step is awaited to its terminal snapshot before the next starts, which is what keeps
 * the runner's single-job guard satisfied without the queue having to know about it.
 */
export async function runQueue(): Promise<RunResult> {
  setState({ phase: "running", stopping: false });

  for (;;) {
    const item = nextRunnable(state.items);
    if (!item) break;

    const input = inputFor(item);
    if (!input) {
      setState({ items: advance(state.items, item.id, { status: "skipped" }) });
      continue;
    }

    const remaining = state.items.filter((i) => i.status !== "skipped");
    const stepIndex = remaining.findIndex((i) => i.id === item.id) + 1;

    setState({ items: advance(state.items, item.id, { status: "running" }) });

    try {
      const jobId = startImportJob(input, {
        step: { index: stepIndex, total: remaining.length },
      });
      markQueuedImportJob(jobId);
      const final = await awaitImportJob(jobId);

      if (final.status === "completed") {
        setState({
          items: advance(state.items, item.id, {
            status: "done",
            result: final.resultMessage,
          }),
        });
      } else if (final.status === "cancelled") {
        setState({
          items: stopAll(
            advance(state.items, item.id, {
              status: "done",
              result: final.resultMessage,
            }),
          ),
        });
        break;
      } else {
        setState({
          items: advance(state.items, item.id, {
            status: "failed",
            error: final.error
              ? friendlyError(new Error(final.error), IMPORT_COPY.importFailed)
              : IMPORT_COPY.importFailed,
          }),
        });
      }
    } catch (err) {
      // A step that could not even start — the runner's single-job guard, or a thrown action.
      setState({
        items: advance(state.items, item.id, {
          status: "failed",
          error: friendlyError(err, IMPORT_COPY.importFailed),
        }),
      });
    }
  }

  setState({ phase: "done", stopping: false });
  return { message: summaryMessage(state.items) };
}

/** Stop the run: cancel what is in flight, and never start what has not begun. */
export function stopQueue() {
  setState({ stopping: true, items: stopAll(state.items) });
  cancelImportJob();
}
