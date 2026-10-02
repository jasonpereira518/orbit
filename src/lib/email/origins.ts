import type { EmailFailureKind, EmailOrigin, EmailSendRecord } from "@/db/schema";

/**
 * What each kind of send does beyond sending. The dispatcher calls these after the row is
 * settled, so they run exactly once per outcome, and in the drain as well as in a request —
 * a hook must not call `requireUserId()` or anything else that needs a request.
 *
 * `interactionSource` keeps each surface's existing `interactions.source`, so current readers
 * (Chat's "already sent" lookup reads `chat_send`) keep working.
 */
export type OriginHooks = {
  interactionSource: string;
  interactionExternalId(send: EmailSendRecord, contactId: string): string;
  onSent?(send: EmailSendRecord): Promise<void>;
  onFailed?(send: EmailSendRecord, kind: EmailFailureKind, message: string): Promise<void>;
};

const defaults = (source: string): OriginHooks => ({
  interactionSource: source,
  interactionExternalId: (send, contactId) => `email-send:${send.id}:${contactId}`,
});

const HOOKS: Record<EmailOrigin, OriginHooks> = {
  compose: defaults("email_send"),
  follow_up: defaults("follow_up"),
  chat: defaults("chat_send"),
  agent: defaults("mcp"),
  recruiter: defaults("recruiter_send"),
};

export function originHooks(origin: EmailOrigin): OriginHooks {
  return HOOKS[origin];
}

/** Each surface registers its behaviour at import time (see `origin-registrations.ts`). */
export function registerOriginHooks(origin: EmailOrigin, hooks: Partial<OriginHooks>) {
  HOOKS[origin] = { ...HOOKS[origin], ...hooks };
}
