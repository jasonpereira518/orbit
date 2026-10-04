"use client";

import { Button } from "@/components/ui/button";
import { useConnectGoogle } from "@/components/settings/use-provider-connection";
import type { SendBlockReason } from "@/lib/email/sender";

const LABEL: Record<SendBlockReason, string> = {
  not_connected: "Connect Gmail",
  no_send_scope: "Allow Gmail to send",
  needs_reauth: "Reconnect Gmail",
};

/** The one CTA a send surface shows when it can't send. Asks only for the send scope. */
export function ConnectMailboxButton({
  reason,
  returnTo,
  size = "sm",
}: {
  reason: SendBlockReason;
  returnTo: string;
  size?: "sm" | "default";
}) {
  const { connect, connecting } = useConnectGoogle(returnTo);
  return (
    <Button type="button" size={size} variant="outline" disabled={connecting} onClick={() => connect(["send"])}>
      {LABEL[reason]}
    </Button>
  );
}
