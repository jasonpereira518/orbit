/**
 * Changes made while offline, waiting to be sent — the storage half.
 *
 * Only actions that are safe to REPLAY go here. "Safe" means sending one twice lands in the
 * same place as sending it once, because a request that died on the network may still have
 * reached the server, and the queue will send it again. Marking a reminder done is safe (done
 * twice is done); "create a note" is not (twice is two notes), and stays a plain failure with
 * the text kept in a draft instead. The kinds are listed in `OFFLINE_ACTION_KINDS` and each
 * one's runner lives in `offline-actions.ts`.
 *
 * Kept in localStorage, scoped by account, so a queued change survives a reload or a closed
 * laptop — and a different account signing in on the same browser never replays someone
 * else's clicks under its own session.
 *
 * Pure apart from the `Storage` it is handed, so `scripts/smoke-offline-queue.ts` can drive it
 * with an in-memory one.
 */

export const OFFLINE_ACTION_KINDS = [
  "reminder.done",
  "reminder.snooze",
  "reminder.reschedule",
] as const;
export type OfflineActionKind = (typeof OFFLINE_ACTION_KINDS)[number];

/** What each kind is called with. A tuple so it can be spread into the action. */
export type OfflineActionArgs = {
  "reminder.done": [reminderId: string];
  "reminder.snooze": [reminderId: string, days: number];
  /** To a calendar day, `YYYY-MM-DD` — absolute, so a late replay lands on the same day. */
  "reminder.reschedule": [reminderId: string, ymd: string];
};

export type OfflineIntent = {
  [K in OfflineActionKind]: {
    kind: K;
    args: OfflineActionArgs[K];
    /**
     * The row the change is about — a reminder id. Lets a card show "waiting to sync" for
     * itself, and lets a second click on the same thing replace the first rather than queue
     * behind it.
     */
    subject: string;
  };
}[OfflineActionKind];

export type QueuedAction = OfflineIntent & {
  id: string;
  queuedAt: number;
};

/**
 * How long a queued change is still worth sending. A reminder marked done on a plane is
 * still done when the plane lands; one marked done a week ago on a laptop that has been shut
 * since is a stale click someone has long forgotten, and replaying it could undo whatever
 * they did about that reminder elsewhere in the meantime.
 */
export const OFFLINE_QUEUE_TTL_MS = 3 * 24 * 60 * 60 * 1000;

/** A backstop, not a design limit: nobody clicks this many things offline on purpose. */
export const OFFLINE_QUEUE_MAX = 100;

const KEY_PREFIX = "orbit:offline-queue:v1";

export function offlineQueueKey(userId: string) {
  return `${KEY_PREFIX}:${userId}`;
}

const ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
const YMD_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Shape-check one entry. localStorage is the person's own machine and anything there can be
 * edited, and these become arguments to Server Actions — so each kind's arguments are
 * checked here, on the way OUT, not trusted because this code once wrote them. (The actions
 * scope every write to the signed-in account regardless; this keeps junk from reaching them.)
 */
export function sanitizeQueuedAction(value: unknown): QueuedAction | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  if (typeof v.id !== "string" || !ID_RE.test(v.id)) return null;
  if (typeof v.queuedAt !== "number" || !Number.isFinite(v.queuedAt)) return null;
  if (typeof v.subject !== "string" || !ID_RE.test(v.subject)) return null;
  if (!Array.isArray(v.args)) return null;
  const base = { id: v.id, queuedAt: v.queuedAt, subject: v.subject };

  switch (v.kind) {
    case "reminder.done": {
      const [reminderId] = v.args;
      if (typeof reminderId !== "string" || !ID_RE.test(reminderId)) return null;
      return { ...base, kind: "reminder.done", args: [reminderId] };
    }
    case "reminder.snooze": {
      const [reminderId, days] = v.args;
      if (typeof reminderId !== "string" || !ID_RE.test(reminderId)) return null;
      if (typeof days !== "number" || !Number.isInteger(days) || days < 1 || days > 90) {
        return null;
      }
      return { ...base, kind: "reminder.snooze", args: [reminderId, days] };
    }
    case "reminder.reschedule": {
      const [reminderId, ymd] = v.args;
      if (typeof reminderId !== "string" || !ID_RE.test(reminderId)) return null;
      if (typeof ymd !== "string" || !YMD_RE.test(ymd)) return null;
      return { ...base, kind: "reminder.reschedule", args: [reminderId, ymd] };
    }
    default:
      return null;
  }
}

/**
 * The queue under `key`, oldest first, with anything expired or malformed dropped. Never
 * throws: storage that is full, disabled or holding junk just means nothing is waiting.
 */
export function readOfflineQueue(
  storage: Pick<Storage, "getItem">,
  key: string,
  now = Date.now()
): QueuedAction[] {
  let raw: string | null;
  try {
    raw = storage.getItem(key);
  } catch {
    return [];
  }
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed
    .map(sanitizeQueuedAction)
    .filter((a): a is QueuedAction => a !== null && now - a.queuedAt <= OFFLINE_QUEUE_TTL_MS)
    .sort((a, b) => a.queuedAt - b.queuedAt)
    .slice(-OFFLINE_QUEUE_MAX);
}

/** Write the queue, or remove the key when it is empty. Returns whether it stuck. */
export function writeOfflineQueue(
  storage: Pick<Storage, "setItem" | "removeItem">,
  key: string,
  queue: readonly QueuedAction[]
): boolean {
  try {
    if (queue.length === 0) storage.removeItem(key);
    else storage.setItem(key, JSON.stringify(queue.slice(-OFFLINE_QUEUE_MAX)));
    return true;
  } catch {
    // Full or disabled storage. The change is still held in memory for this tab.
    return false;
  }
}

/**
 * Add a change. The newest change to a subject wins: done-then-snooze on the same reminder
 * means the person changed their mind, and replaying both in order would land on the second
 * anyway — so the first is dropped and the second takes its place at the back of the line.
 */
export function enqueueOfflineAction(
  queue: readonly QueuedAction[],
  intent: OfflineIntent,
  now = Date.now(),
  id = newQueueId(now)
): QueuedAction[] {
  const kept = queue.filter((a) => a.subject !== intent.subject);
  return [...kept, { ...intent, id, queuedAt: now } as QueuedAction].slice(-OFFLINE_QUEUE_MAX);
}

export function removeQueuedAction(queue: readonly QueuedAction[], id: string): QueuedAction[] {
  return queue.filter((a) => a.id !== id);
}

function newQueueId(now: number) {
  return `q${now.toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

/** "1 change", "3 changes" — for the banner and the sync toast. */
export function changesLabel(count: number) {
  return `${count} ${count === 1 ? "change" : "changes"}`;
}
