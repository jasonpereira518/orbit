"use client";
import { useEffect, useRef, useState } from "react";
import { ComposerSendButton } from "./composer-send-button";
import type { VoicePublicState } from "@/lib/voice/contracts";
import { openVoice, updateVoiceState, useVoiceDock } from "@/lib/voice/dock-store";
/** The composer's send/voice button. The call itself lives in `VoiceDock`, above the page. */
export function OrbitVoiceEntry({ hasText, busy, disabled, onSend, onStop, prepare }: {
  hasText: boolean; busy: boolean; disabled: boolean;
  onSend(): void; onStop(): void; prepare(): Promise<string>;
}) {
  const [state, setState] = useState<VoicePublicState | null>(null);
  const live = Boolean(useVoiceDock().call);
  const [opening, setOpening] = useState(false);
  const [error, setError] = useState("");
  const guard = useRef(false);
  useEffect(() => {
    let alive = true;
    async function check() {
      try {
        const response = await fetch("/api/voice", { cache: "no-store" });
        const data = await response.json();
        if (alive && response.ok) {
          setState(data);
          updateVoiceState(data);
        }
      } catch {
        // An active session owns its cleanup; a failed status poll must not unmount it.
      }
    }
    void check();
    const timer = setInterval(() => void check(), 15000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, []);
  async function open() {
    if (guard.current || !state) return;
    guard.current = true;
    setOpening(true);
    setError("");
    try { openVoice(await prepare(), state); }
    catch { setError("Couldn’t open Orbit Voice. Try again."); }
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
