"use client";

import { useState, useTransition } from "react";
import { saveEmailSignatureAction } from "@/actions/settings";
import { ConnectMailboxButton } from "@/components/email/connect-mailbox-button";
import { SettingsRow, SettingsSection } from "@/components/settings/settings-section";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import type { SendCapability } from "@/lib/email/sender";
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
  const capability = initial?.capability ?? null;
  const [pending, start] = useTransition();

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
        ) : capability.ok ? (
          <p className="text-sm">
            <span className="font-medium">{capability.fromEmail}</span>
            <span className="ml-2 text-xs text-muted-foreground">
              {capability.usedToday} of {capability.dailyCap} sent today
            </span>
          </p>
        ) : capability.reason === "cap_reached" ? (
          <p className="text-sm text-muted-foreground">
            You’ve reached today’s email limit ({capability.dailyCap})
          </p>
        ) : (
          <ConnectMailboxButton reason={capability.reason} returnTo="/settings#settings-email" />
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
