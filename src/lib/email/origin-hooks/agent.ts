import { finishAgentSend, markAgentSendAmbiguous } from "@/lib/agent-sends";
import { registerOriginHooks } from "@/lib/email/origins";

// An approved assistant draft. `origin_ref` is the agent_send_requests id, and the interaction
// keeps the key it has always had, so an approval logged before the outbox matches one after.
registerOriginHooks("agent", {
  interactionExternalId: (send) => `mcp:send:${send.originRef}`,
  async onSent(send) {
    if (send.originRef) {
      await finishAgentSend(send.originRef, { ok: true, deliveryId: send.providerMessageId ?? undefined });
    }
  },
  async onFailed(send, kind, message) {
    if (!send.originRef) return;
    if (kind === "ambiguous") await markAgentSendAmbiguous(send.originRef);
    else await finishAgentSend(send.originRef, { ok: false, error: friendlyReason(kind, message) });
  },
});

/** The draft card shows this; provider text never reaches it. */
function friendlyReason(kind: string, _message: string): string {
  if (kind === "auth") return "Gmail needs reconnecting before this can send.";
  if (kind === "exhausted") return "Gmail kept failing, so this didn’t send. Try again later.";
  return "Gmail didn’t accept this message.";
}
