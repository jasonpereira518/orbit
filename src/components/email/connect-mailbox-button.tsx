"use client";

import { Button } from "@/components/ui/button";
import { useConnectGoogle, useConnectMicrosoft } from "@/components/settings/use-provider-connection";
import type { MailboxId, SendBlockReason } from "@/lib/email/sender";

const NAME: Record<MailboxId, string> = { gmail: "Gmail", outlook: "Outlook" };

/**
 * The one CTA a send surface shows when it can't send. Asks each provider only for its send
 * permission. With nothing connected it offers every mailbox this deployment supports; with a
 * mailbox that needs fixing it names that one.
 */
export function ConnectMailboxButton({
  reason,
  provider,
  outlookAvailable,
  returnTo,
  size = "sm",
}: {
  reason: SendBlockReason;
  provider: MailboxId | null;
  outlookAvailable: boolean;
  returnTo: string;
  size?: "sm" | "default";
}) {
  const google = useConnectGoogle(returnTo);
  const microsoft = useConnectMicrosoft(returnTo);
  const connect = (id: MailboxId) => (id === "gmail" ? google.connect(["send"]) : microsoft.connect(["send"]));
  const busy = google.connecting || microsoft.connecting;

  if (reason === "not_connected" || !provider) {
    return (
      <span className="inline-flex flex-wrap gap-2">
        <Button type="button" size={size} variant="outline" disabled={busy} onClick={() => connect("gmail")}>
          Connect Gmail
        </Button>
        {outlookAvailable && (
          <Button type="button" size={size} variant="outline" disabled={busy} onClick={() => connect("outlook")}>
            Connect Outlook
          </Button>
        )}
      </span>
    );
  }
  return (
    <Button type="button" size={size} variant="outline" disabled={busy} onClick={() => connect(provider)}>
      {reason === "needs_reauth" ? `Reconnect ${NAME[provider]}` : `Allow ${NAME[provider]} to send`}
    </Button>
  );
}
