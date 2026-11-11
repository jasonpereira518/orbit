import type { ChatAttachment } from "@/lib/chat-attachments";

/**
 * Messages typed while an answer is still being written.
 *
 * Each waits its turn and is sent when the answer before it lands. One may instead be sent
 * to steer the running answer (`steerChatTurn`); the turn confirms it took the message with
 * a `steer:<id>` step, and only then does it leave the queue. A steer the turn never took,
 * because the model was already writing its last round, is still here when the turn ends, so
 * it goes out as the next message. Nothing typed is dropped.
 *
 * Pure, so `scripts/smoke-chat-queue.ts` can pin the rules.
 */
export type QueuedMessage = {
  /** A uuid: also the steer's id on the server. */
  id: string;
  text: string;
  /** The people `@`-mentioned when it was typed, resolved then so a later edit cannot drop them. */
  contextContactIds: string[];
  /** Files that were in the composer when it was queued. A message with files is never a steer. */
  attachments?: ChatAttachment[];
  /** Sent to steer the running answer and not yet confirmed. */
  steering?: boolean;
};

export const CHAT_QUEUE_MAX = 5;

/** The queue with `item` at the end, or the same queue when it is full or the text is blank. */
export function enqueue(queue: QueuedMessage[], item: QueuedMessage): QueuedMessage[] {
  if (!item.text.trim() || queue.length >= CHAT_QUEUE_MAX) return queue;
  return [...queue, item];
}

export function setSteering(queue: QueuedMessage[], id: string, steering: boolean): QueuedMessage[] {
  return queue.map((item) => (item.id === id ? { ...item, steering } : item));
}

/** The id a `steer:<id>` step confirms, or null for any other step. */
export function steeredId(stepId: string): string | null {
  return stepId.startsWith("steer:") ? stepId.slice("steer:".length) : null;
}

/** When a turn ends: a steer it never confirmed is an ordinary queued message again. */
export function afterTurn(queue: QueuedMessage[]): QueuedMessage[] {
  return queue.some((item) => item.steering) ? queue.map((item) => ({ ...item, steering: false })) : queue;
}
