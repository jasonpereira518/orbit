"use client";
import { useRef, useState } from "react";
import { ComposerSendButton } from "./composer-send-button";
import { openVoice, useVoiceDock } from "@/lib/voice/dock-store";
/**
 * The composer's send/voice button: with nothing typed, it wakes Cosmo in this thread (Chat's
 * stage). The call lives in `VoiceDock`; whether voice is on comes from the one status read
 * CosmoRoot makes per page, not a poll of its own.
 */
export function OrbitVoiceEntry({ hasText, busy, disabled, onSend, onStop, prepare }: {
  hasText: boolean; busy: boolean; disabled: boolean;
  onSend(): void; onStop(): void; prepare(): Promise<string>;
}) {
  const { call, state } = useVoiceDock();
  const live = Boolean(call);
  const [opening, setOpening] = useState(false);
  const [error, setError] = useState("");
  const guard = useRef(false);
  async function open() {
    if (guard.current || !state) return;
    guard.current = true;
    setOpening(true);
    setError("");
    try { openVoice(await prepare(), state); }
    catch { setError("Couldn’t wake Cosmo. Try again."); }
    finally { guard.current = false; setOpening(false); }
  }
  return (
    <>
      <ComposerSendButton mode={hasText ? "send" : "voice"} busy={busy}
        disabled={disabled || opening || (!hasText && (!state?.enabled || live))}
        onStop={onStop} onClick={hasText ? onSend : () => void open()} />
      {error && <span role="alert" className="absolute bottom-full right-0 mb-2 rounded-lg bg-background p-3 text-sm text-destructive">{error}</span>}
    </>
  );
}
