import { registerOriginHooks } from "@/lib/email/origins";
import { clearContactFollowUpForUser } from "@/lib/reminder-writes";

// Chat's "already sent" badge reads interactions by this exact key (`src/actions/chat.ts`),
// so the interaction reuses the idempotency key rather than the generic email-send id.
registerOriginHooks("chat", {
  interactionExternalId: (send, contactId) => send.idempotencyKey ?? `email-send:${send.id}:${contactId}`,
  async onSent(send) {
    // Emailing someone from Chat answers their follow-up, as it did before the outbox.
    for (const contactId of send.contactIds) await clearContactFollowUpForUser(send.userId, contactId);
  },
});
