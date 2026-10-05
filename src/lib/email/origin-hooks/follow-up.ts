import { registerOriginHooks } from "@/lib/email/origins";
import { clearContactFollowUpForUser } from "@/lib/reminder-writes";

// A follow-up is cleared only once the email actually went out: an undone or failed send
// leaves it due. `origin_ref` is the id of the contact the follow-up belongs to.
registerOriginHooks("follow_up", {
  async onSent(send) {
    if (send.originRef) await clearContactFollowUpForUser(send.userId, send.originRef);
  },
});
