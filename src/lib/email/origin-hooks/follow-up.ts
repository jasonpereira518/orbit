import { registerOriginHooks } from "@/lib/email/origins";
import { markContactReachedOutForUser } from "@/lib/radar/actions-core";
import { clearContactFollowUpForUser } from "@/lib/reminder-writes";

// A follow-up is cleared only once the email actually went out: an undone or failed send
// leaves it due. `origin_ref` is the id of the contact the follow-up belongs to. The same
// moment answers their Radar card and any congratulations nudge.
registerOriginHooks("follow_up", {
  async onSent(send) {
    if (!send.originRef) return;
    await clearContactFollowUpForUser(send.userId, send.originRef);
    await markContactReachedOutForUser(send.userId, send.originRef, send.sentAt ?? new Date());
  },
});
