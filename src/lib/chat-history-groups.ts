/**
 * Groups saved chats the way every chat app does — Today, Yesterday, then progressively
 * coarser buckets — so a long history reads as a timeline rather than a flat list.
 *
 * Pure and clock-injected: "today" is a calendar day in the reader's own timezone, not "the
 * last 24 hours", so the caller passes `now` and this never reads the clock itself. That
 * keeps the boundary cases (a chat from 23:50 last night, opened at 00:10) testable.
 */

export type ThreadLike = {
  id: string;
  title: string | null;
  updatedAt: Date | string;
};

export type ThreadGroup<T extends ThreadLike> = {
  /** Stable key, also the visible heading. */
  label: "Today" | "Yesterday" | "Previous 7 days" | "Earlier";
  threads: T[];
};

const DAY_MS = 24 * 60 * 60 * 1000;

/** Midnight at the start of `d`'s local calendar day. */
function startOfDay(d: Date): number {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

export function groupThreadsByDay<T extends ThreadLike>(
  threads: readonly T[],
  now: Date = new Date()
): ThreadGroup<T>[] {
  const today = startOfDay(now);
  const buckets: Record<ThreadGroup<T>["label"], T[]> = {
    Today: [],
    Yesterday: [],
    "Previous 7 days": [],
    Earlier: [],
  };

  // Newest first inside each bucket, whatever order the caller passed them in.
  const sorted = [...threads].sort(
    (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
  );

  for (const thread of sorted) {
    const when = new Date(thread.updatedAt);
    // An unparseable date has no honest bucket; "Earlier" is the least misleading.
    if (Number.isNaN(when.getTime())) {
      buckets.Earlier.push(thread);
      continue;
    }
    const day = startOfDay(when);
    if (day >= today) buckets.Today.push(thread);
    else if (day >= today - DAY_MS) buckets.Yesterday.push(thread);
    else if (day >= today - 7 * DAY_MS) buckets["Previous 7 days"].push(thread);
    else buckets.Earlier.push(thread);
  }

  // Empty buckets are dropped, so a new user never sees a "Yesterday" heading with nothing
  // under it.
  return (Object.keys(buckets) as ThreadGroup<T>["label"][])
    .filter((label) => buckets[label].length > 0)
    .map((label) => ({ label, threads: buckets[label] }));
}
