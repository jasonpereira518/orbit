import type { ReminderActionKind } from "@/db/schema";

export const REMINDER_ACTION_KINDS: ReminderActionKind[] = [
  "call",
  "email",
  "meet",
  "follow_up",
  "task",
];

export const ACTION_KIND_LABELS: Record<ReminderActionKind, string> = {
  call: "Call",
  email: "Email",
  meet: "Meet",
  follow_up: "Follow up",
  task: "Task",
};

const CALL_RE =
  /\b(call|phone|ring|dial|catch up by phone|phone call)\b/i;
const EMAIL_RE =
  /\b(email|e-mail|write|send (an? )?(note|message|mail)|reply|respond)\b/i;
const MEET_RE =
  /\b(meet|meeting|coffee|lunch|dinner|hangout|catch up in person|zoom|video call|sync)\b/i;
const FOLLOW_UP_RE =
  /\b(follow[- ]?up|reach out|check in|reconnect|touch base)\b/i;

/**
 * Infer a quick-action kind from reminder text and context.
 * Pure heuristic — no AI. Prefer explicit keyword matches over contact linkage.
 */
export function inferReminderActionKind(input: {
  title: string;
  description?: string | null;
  reminderType?: string | null;
  contactId?: string | null;
}): ReminderActionKind {
  const text = `${input.title} ${input.description ?? ""}`.trim();

  if (CALL_RE.test(text)) return "call";
  if (MEET_RE.test(text)) return "meet";
  if (EMAIL_RE.test(text)) return "email";
  if (FOLLOW_UP_RE.test(text)) return "follow_up";

  const type = (input.reminderType || "").toLowerCase();
  if (
    type === "ai_suggested" ||
    type === "generated" ||
    type === "post_meeting" ||
    type === "capture"
  ) {
    return input.contactId ? "follow_up" : "task";
  }

  if (input.contactId) return "follow_up";
  return "task";
}

export function isReminderActionKind(value: string): value is ReminderActionKind {
  return (REMINDER_ACTION_KINDS as string[]).includes(value);
}
