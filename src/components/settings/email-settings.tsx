"use client";

import { useState, useTransition } from "react";
import { saveDefaultSendProviderAction, saveEmailSignatureAction } from "@/actions/settings";
import { ConnectMailboxButton } from "@/components/email/connect-mailbox-button";
import { MailboxSelect } from "@/components/email/mailbox-select";
import { SettingsRow, SettingsSection } from "@/components/settings/settings-section";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import type { MailboxId, SendCapability } from "@/lib/email/sender";
import { SIGNATURE_MAX } from "@/lib/email/signature";
import { friendlyError, TIMEOUT_MESSAGE } from "@/lib/errors";
import { toast } from "@/lib/toast";

/**
 * How long to wait for a save before saying so. The settings page replaceStates on mount, and
 * a Next router restore drops any server action queued at that moment, so a stalled action
 * reads as a hang rather than a rejection (see `calendar-feed-settings.tsx`).
 */
const SAVE_TIMEOUT_MS = 12_000;

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(TIMEOUT_MESSAGE)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      }
    );
  });
}

/**
 * Signature and sending account for email written in Orbit's Compose. The initial values are
 * read by the settings page on the server, so nothing here fetches on mount.
 */
export function EmailSettings({
  initial,
}: {
  initial: { signature: string | null; capability: SendCapability } | null;
}) {
  const [saved, setSaved] = useState(initial?.signature ?? "");
  const [text, setText] = useState(initial?.signature ?? "");
  const [capability, setCapability] = useState<SendCapability | null>(initial?.capability ?? null);
  const [pending, start] = useTransition();
  const [switching, startSwitch] = useTransition();

  function chooseDefault(id: MailboxId) {
    startSwitch(async () => {
      try {
        const next = await withTimeout(saveDefaultSendProviderAction(id), SAVE_TIMEOUT_MS);
        setCapability(next);
        const email = next.mailboxes.find((m) => m.id === id)?.email;
        toast.success(email ? `Sending from ${email}` : "Default mailbox saved");
      } catch (err) {
        toast.error(friendlyError(err, "Couldn’t change that — try again?"));
      }
    });
  }

  function save() {
    start(async () => {
      try {
        const res = await withTimeout(saveEmailSignatureAction(text), SAVE_TIMEOUT_MS);
        setSaved(res.signature ?? "");
        setText(res.signature ?? "");
        toast.success(res.signature ? "Signature saved" : "Signature cleared");
      } catch (err) {
        toast.error(friendlyError(err, "Couldn’t save your signature — try again?"));
      }
    });
  }

  return (
    <SettingsSection title="Email" description="How email you write in Orbit is sent and signed.">
      <SettingsRow
        title="Sending from"
        description="Email you send from Orbit leaves from this address and lands in its Sent folder."
      >
        {!capability ? (
          <p className="text-sm text-muted-foreground">Couldn’t check your mailbox — reload to try again</p>
        ) : (
          <div className="flex flex-col gap-2">
            {capability.ok && capability.mailboxes.filter((m) => m.canSend).length > 1 ? (
              <MailboxSelect
                mailboxes={capability.mailboxes}
                value={capability.provider === "outlook" ? "outlook" : "gmail"}
                onChange={chooseDefault}
                disabled={switching}
                label="Default mailbox"
              />
            ) : capability.ok ? (
              <p className="text-sm font-medium">{capability.fromEmail}</p>
            ) : capability.reason === "cap_reached" ? null : (
              <ConnectMailboxButton
                reason={capability.reason}
                provider={capability.provider}
                outlookAvailable={capability.outlookAvailable}
                returnTo="/settings#settings-email"
              />
            )}
            {/* A second mailbox that could send too, once allowed. */}
            {capability.ok &&
              capability.mailboxes
                .filter((m) => !m.canSend)
                .map((m) => (
                  <ConnectMailboxButton
                    key={m.id}
                    reason={m.needsReauth ? "needs_reauth" : "no_send_scope"}
                    provider={m.id}
                    outlookAvailable={capability.outlookAvailable}
                    returnTo="/settings#settings-email"
                  />
                ))}
            <p className="text-xs text-muted-foreground">
              {!capability.ok && capability.reason === "cap_reached"
                ? `You’ve reached today’s email limit (${capability.dailyCap})`
                : `${capability.usedToday} of ${capability.dailyCap} sent today`}
            </p>
          </div>
        )}
      </SettingsRow>
      <SettingsRow title="Signature" description="Added under emails you write in Compose. Plain text.">
        <div className="flex w-full flex-col gap-2">
          <Textarea
            aria-label="Email signature"
            rows={4}
            value={text}
            maxLength={SIGNATURE_MAX}
            onChange={(e) => setText(e.target.value)}
            placeholder={"Your name\nWhat you do"}
            disabled={pending}
          />
          <div className="flex justify-end">
            <Button type="button" size="sm" onClick={save} disabled={pending || text === saved}>
              Save signature
            </Button>
          </div>
        </div>
      </SettingsRow>
    </SettingsSection>
  );
}
