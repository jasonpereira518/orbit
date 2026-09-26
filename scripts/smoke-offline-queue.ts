/**
 * The offline queue: changes made without a connection, held on the device and sent when it
 * comes back.
 *
 * Three layers, each checked here:
 * - storage (`offline-queue.ts`, pure): shape checks on the way out, expiry, one entry per
 *   subject, per-account keys, storage that throws;
 * - replay (`offline-queue-store.ts`): oldest first, stops on a network failure and keeps the
 *   rest, drops what the server refuses so one bad entry cannot wedge the queue;
 * - the click (`runToastAction` with `offline`): queued instead of failed, with no Undo, and
 *   never queued when the caller did not say the change is safe to replay.
 *
 * localStorage, window and sonner are stubbed for Node, as in smoke-toast-actions.ts.
 *
 * Run: npx tsx scripts/smoke-offline-queue.ts
 */
const store = new Map<string, string>();
const memory = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
};
const g = globalThis as unknown as Record<string, unknown>;
g.localStorage = memory;
g.window = { localStorage: memory, addEventListener() {}, removeEventListener() {} };
g.document = { visibilityState: "visible", addEventListener() {}, removeEventListener() {} };
// The connectivity probe (`HEAD /favicon.ico`) — answered, so a reported network failure
// is followed by "reachable again" rather than leaving the store stuck unreachable.
g.fetch = async () => new Response(null, { status: 200 });

import { toast as sonnerToast } from "sonner";
import {
  OFFLINE_QUEUE_MAX,
  OFFLINE_QUEUE_TTL_MS,
  changesLabel,
  enqueueOfflineAction,
  offlineQueueKey,
  readOfflineQueue,
  sanitizeQueuedAction,
  writeOfflineQueue,
  type QueuedAction,
} from "../src/lib/offline-queue";

let failures = 0;
function check(name: string, cond: boolean, extra?: unknown) {
  if (cond) {
    console.log(`  ok   ${name}`);
    return;
  }
  failures++;
  console.log(`  FAIL ${name}`, extra ?? "");
}

const calls: { variant: string; message: unknown; data: { action?: unknown } }[] = [];
const patchable = sonnerToast as unknown as Record<string, unknown>;
for (const v of ["error", "success", "warning", "info", "message"] as const) {
  patchable[v] = (message: unknown, data?: { action?: unknown }) => {
    calls.push({ variant: v, message, data: data ?? {} });
    return `id-${calls.length}`;
  };
}

const R1 = "0b7f6a52-1111-4e2a-9d51-6f0c2b1a0001";
const R2 = "0b7f6a52-2222-4e2a-9d51-6f0c2b1a0002";
const R3 = "0b7f6a52-3333-4e2a-9d51-6f0c2b1a0003";

async function main() {
  console.log("Storage");
  {
    const key = offlineQueueKey("user_a");
    check("keys are per account", key !== offlineQueueKey("user_b") && key.includes("user_a"));

    let q: QueuedAction[] = [];
    q = enqueueOfflineAction(q, { kind: "reminder.done", args: [R1], subject: R1 }, 1000, "qa");
    q = enqueueOfflineAction(q, { kind: "reminder.snooze", args: [R2, 7], subject: R2 }, 2000, "qb");
    check("queues in order", q.map((a) => a.id).join() === "qa,qb");

    q = enqueueOfflineAction(q, { kind: "reminder.snooze", args: [R1, 7], subject: R1 }, 3000, "qc");
    check(
      "a second change to the same reminder replaces the first, at the back",
      q.map((a) => a.id).join() === "qb,qc" && q[1].kind === "reminder.snooze",
      q.map((a) => `${a.id}:${a.kind}`)
    );

    writeOfflineQueue(memory, key, q);
    const back = readOfflineQueue(memory, key, 4000);
    check("round-trips through storage", back.length === 2 && back[0].id === "qb" && back[1].id === "qc");

    check(
      "expired entries are dropped on read",
      readOfflineQueue(memory, key, 2000 + OFFLINE_QUEUE_TTL_MS + 1).map((a) => a.id).join() === "qc"
    );

    writeOfflineQueue(memory, key, []);
    check("an empty queue removes the key", memory.getItem(key) === null);

    memory.setItem(key, "{not json");
    check("junk in storage reads as an empty queue", readOfflineQueue(memory, key).length === 0);

    const throwing = {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("denied");
      },
      removeItem: () => {
        throw new Error("denied");
      },
    };
    check("storage that throws reads as empty", readOfflineQueue(throwing, key).length === 0);
    check("  and a write reports it did not stick", writeOfflineQueue(throwing, key, q) === false);

    let many: QueuedAction[] = [];
    for (let i = 0; i < OFFLINE_QUEUE_MAX + 20; i++) {
      const id = `0b7f6a52-0000-4e2a-9d51-${String(i).padStart(12, "0")}`;
      many = enqueueOfflineAction(many, { kind: "reminder.done", args: [id], subject: id }, i, `q${i}`);
    }
    check("the queue is capped, keeping the newest", many.length === OFFLINE_QUEUE_MAX && many[0].id === "q20");
  }

  console.log("\nShape checks on the way out (the entries become Server Action arguments)");
  {
    const ok = { id: "q1", queuedAt: 1, subject: R1, kind: "reminder.done", args: [R1] };
    check("a well-formed entry passes", sanitizeQueuedAction(ok) !== null);
    check("an unknown kind is refused", sanitizeQueuedAction({ ...ok, kind: "contact.delete" }) === null);
    check("an id with odd characters is refused", sanitizeQueuedAction({ ...ok, args: ["1; drop table"] }) === null);
    check(
      "a snooze outside 1–90 days is refused",
      sanitizeQueuedAction({ ...ok, kind: "reminder.snooze", args: [R1, 9999] }) === null
    );
    check(
      "a reschedule needs a YYYY-MM-DD day",
      sanitizeQueuedAction({ ...ok, kind: "reminder.reschedule", args: [R1, "next tuesday"] }) === null &&
        sanitizeQueuedAction({ ...ok, kind: "reminder.reschedule", args: [R1, "2026-10-01"] }) !== null
    );
    check("extra arguments are not carried through", (sanitizeQueuedAction({ ...ok, args: [R1, "x"] })?.args.length ?? 0) === 1);
    check("labels count properly", changesLabel(1) === "1 change" && changesLabel(3) === "3 changes");
  }

  const qs = await import("../src/lib/offline-queue-store");
  const { runToastAction, QUEUED_OFFLINE_COPY } = await import("../src/lib/toast");

  console.log("\nReplay");
  {
    const sent: string[] = [];
    let failNext: Error | null = null;
    const runner = async (item: { args: readonly unknown[] }) => {
      if (failNext) {
        const e = failNext;
        failNext = null;
        throw e;
      }
      sent.push(String(item.args[0]));
    };
    const teardown = qs.configureOfflineQueue("user_a", {
      "reminder.done": runner,
      "reminder.snooze": runner,
      "reminder.reschedule": runner,
    });

    check("nothing queued before anything is clicked", !qs.isQueuedOffline(R1));
    qs.queueOfflineAction({ kind: "reminder.done", args: [R1], subject: R1 });
    qs.queueOfflineAction({ kind: "reminder.snooze", args: [R2, 7], subject: R2 });
    qs.queueOfflineAction({ kind: "reminder.reschedule", args: [R3, "2026-10-01"], subject: R3 });
    check("a queued reminder says so", qs.isQueuedOffline(R1));
    check("it is written to this account's storage", readOfflineQueue(memory, offlineQueueKey("user_a")).length === 3);

    failNext = new TypeError("Failed to fetch");
    const stalled = await qs.flushOfflineQueue();
    check("a network failure stops the replay", stalled.stalled && stalled.sent === 0, stalled);
    check("  and keeps everything for next time", readOfflineQueue(memory, offlineQueueKey("user_a")).length === 3);

    failNext = new Error("Reminder not found");
    const partial = await qs.flushOfflineQueue();
    check("a refused change is dropped, the rest still go", partial.dropped === 1 && partial.sent === 2, partial);
    check("  in the order they were made", sent.join() === `${R2},${R3}`, sent);
    check("  leaving nothing behind", readOfflineQueue(memory, offlineQueueKey("user_a")).length === 0 && !qs.isQueuedOffline(R2));

    failNext = new Error("An unexpected response was received from the server.");
    qs.queueOfflineAction({ kind: "reminder.done", args: [R1], subject: R1 });
    const deploy = await qs.flushOfflineQueue();
    check("an edge error page mid-deploy is retried later, not dropped", deploy.stalled && deploy.dropped === 0, deploy);
    await qs.flushOfflineQueue();

    console.log("\nThe click");
    calls.length = 0;
    let ran = 0;
    const nav = globalThis.navigator as unknown as { onLine: boolean };
    const hadOnLine = Object.getOwnPropertyDescriptor(nav, "onLine");
    Object.defineProperty(nav, "onLine", { value: false, configurable: true });
    const offlineResult = await runToastAction({
      run: async () => {
        ran++;
        return 1;
      },
      success: "Marked done",
      failure: "Couldn’t mark that done — try again?",
      undo: () => async () => ({ restored: true }),
      offline: { kind: "reminder.done", args: [R1], subject: R1 },
    });
    if (hadOnLine) Object.defineProperty(nav, "onLine", hadOnLine);
    else delete (nav as { onLine?: boolean }).onLine;
    check("offline, the action is not even tried", ran === 0);
    check("  it is queued", qs.isQueuedOffline(R1));
    check("  and the caller gets no result (nothing happened yet)", offlineResult === undefined);
    check(
      "  one quiet message, no Undo",
      calls.length === 1 && calls[0].message === QUEUED_OFFLINE_COPY && !calls[0].data.action,
      calls
    );
    await qs.flushOfflineQueue();

    calls.length = 0;
    await runToastAction({
      run: async () => {
        throw new TypeError("Failed to fetch");
      },
      success: "Snoozed",
      failure: "Couldn’t snooze that — try again?",
      offline: { kind: "reminder.snooze", args: [R2, 7], subject: R2 },
    });
    check("a request that dies on the network is queued too", qs.isQueuedOffline(R2));
    check("  with the queued message, not an error", calls.length === 1 && calls[0].message === QUEUED_OFFLINE_COPY, calls);
    await qs.flushOfflineQueue();

    calls.length = 0;
    await runToastAction({
      run: async () => {
        throw new TypeError("Failed to fetch");
      },
      success: "Logged",
      failure: "Couldn’t log that — try again?",
    });
    check(
      "without `offline`, a network failure is still an error — nothing unsafe is replayed",
      calls.length === 1 && calls[0].variant === "error",
      calls
    );

    calls.length = 0;
    await runToastAction({
      run: async () => {
        throw new Error("boom");
      },
      success: "Snoozed",
      failure: "Couldn’t snooze that — try again?",
      offline: { kind: "reminder.snooze", args: [R3, 7], subject: R3 },
    });
    check("a server fault is not queued", !qs.isQueuedOffline(R3) && calls[0]?.variant === "error", calls);

    teardown();
    check("queueing is off once the account's queue is closed", !qs.queueOfflineAction({ kind: "reminder.done", args: [R1], subject: R1 }));
  }

  if (failures) {
    console.log(`\nsmoke-offline-queue: ${failures} FAILED`);
    process.exit(1);
  }
  console.log("\nsmoke-offline-queue: all checks passed");
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
