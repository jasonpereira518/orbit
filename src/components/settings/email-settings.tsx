"use client";

import { useEffect, useState, useTransition } from "react";
import { getEmailSettings, saveEmailSignatureAction } from "@/actions/settings";
import { ConnectMailboxButton } from "@/components/email/connect-mailbox-button";
import { SettingsRow, SettingsSection } from "@/components/settings/settings-section";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import type { SendCapability } from "@/lib/email/sender";
import { SIGNATURE_MAX } from "@/lib/email/signature";
import { friendlyError } from "@/lib/errors";
import { toast } from "@/lib/toast";

/** Signature and sending account for email written in Orbit's Compose. */
export function EmailSettings() {
  const [loaded, setLoaded] = useState(false);
  const [saved, setSaved] = useState("");
  const [text, setText] = useState("");
  const [capability, setCapability] = useState<SendCapability | null>(null);
  const [pending, start] = useTransition();

  useEffect(() => {
    let cancelled = false;
    getEmailSettings()
      .then(({ signature, capability: cap }) => {
        if (cancelled) return;
        setSaved(signature ?? "");
        setText(signature ?? "");
        setCapability(cap);
        setLoaded(true);
      })
      .catch(() => {
        if (!cancelled) setLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  function save() {
    start(async () => {
      try {
        const res = await saveEmailSignatureAction(text);
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
          loaded ? (
            <p className="text-sm text-muted-foreground">Couldn’t check your mailbox</p>
          ) : (
            <Skeleton className="h-4 w-44" />
          )
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
        {!loaded ? (
          <Skeleton className="h-20 w-full" />
        ) : (
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
        )}
      </SettingsRow>
    </SettingsSection>
  );
}
