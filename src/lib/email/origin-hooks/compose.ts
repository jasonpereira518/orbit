import { registerOriginHooks } from "@/lib/email/origins";
import { clearContactFollowUpForUser } from "@/lib/reminder-writes";

// Emailing someone from Compose answers their follow-up, the same as a Chat send. Every
// matched contact counts — the CC'd colleague you owed a reply is answered too.
registerOriginHooks("compose", {
  async onSent(send) {
    for (const contactId of send.contactIds) await clearContactFollowUpForUser(send.userId, contactId);
  },
});
