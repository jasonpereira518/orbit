/**
 * The queue of messages typed while an answer is being written (`@/lib/chat-queue`).
 *
 * Pure: no network, no database. Run: npx tsx scripts/smoke-chat-queue.ts
 * The steer's server half (the loop handing it to the model) is in smoke-tool-loop.ts.
 */
import { CHAT_QUEUE_MAX, afterTurn, enqueue, setSteering, steeredId, type QueuedMessage } from "../src/lib/chat-queue";

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  console.log(`  ${ok ? "ok  " : "FAIL"} ${name}${ok || !detail ? "" : ` (${detail})`}`);
  if (!ok) failures++;
}
const msg = (id: string, text = `message ${id}`): QueuedMessage => ({ id, text, contextContactIds: [] });

let queue: QueuedMessage[] = [];
queue = enqueue(queue, msg("a"));
queue = enqueue(queue, msg("b"));
check("messages queue in the order they were typed", queue.map((m) => m.id).join() === "a,b");

const blank = enqueue(queue, msg("x", "   "));
check("a blank message is not queued, and the caller can tell", blank === queue);

let full = queue;
for (let i = 0; i < CHAT_QUEUE_MAX + 2; i++) full = enqueue(full, msg(`f${i}`));
check("the queue stops at its cap", full.length === CHAT_QUEUE_MAX, String(full.length));
check("a full queue is returned as is, so the text stays in the box", enqueue(full, msg("z")) === full);

check("only a steer step names a queued message", steeredId("steer:abc") === "abc" && steeredId("gather:1") === null);

const steering = setSteering(queue, "b", true);
check("steering marks only that message", steering[1].steering === true && !steering[0].steering);

const ended = afterTurn(steering);
check(
  "a steer the turn never confirmed is still queued when the turn ends, as an ordinary message",
  ended.length === 2 && ended.every((m) => !m.steering),
);
check("a turn ending with nothing steering leaves the queue untouched", afterTurn(queue) === queue);

console.log(failures === 0 ? "\nsmoke-chat-queue: all checks passed" : `\nsmoke-chat-queue: ${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
