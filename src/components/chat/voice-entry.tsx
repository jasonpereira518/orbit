"use client";
import dynamic from "next/dynamic";
import { useEffect, useRef, useState, type RefObject } from "react";
import { ComposerSendButton } from "./composer-send-button";
import type { VoicePublicState } from "@/lib/voice/contracts";
const VoicePanel = dynamic(
  () => import("./voice-panel").then((m) => m.VoicePanel),
  { ssr: false },
);
export function OrbitVoiceEntry({ hasText, busy, disabled, onSend, onStop, prepare, onEnd, surfaceRef }: {
  surfaceRef: RefObject<HTMLDivElement | null>;
  hasText: boolean; busy: boolean; disabled: boolean;
  onSend(): void; onStop(): void; prepare(): Promise<string>; onEnd(threadId: string): Promise<void>;
}) {
  const [state, setState] = useState<VoicePublicState | null>(null);
  const [thread, setThread] = useState<string | null>(null);
  const [opening, setOpening] = useState(false);
  const [error, setError] = useState("");
  const guard = useRef(false);
  useEffect(() => {
    let alive = true;
    async function check() {
      try {
        const response = await fetch("/api/voice", { cache: "no-store" });
        const data = await response.json();
        if (alive && response.ok) setState(data);
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
    if (guard.current) return;
    guard.current = true;
    setOpening(true);
    setError("");
    try { setThread(await prepare()); }
    catch { setError("Couldn’t open Orbit Voice. Try again."); }
    finally { guard.current = false; setOpening(false); }
  }
  return (
    <>
      <ComposerSendButton mode={hasText ? "send" : "voice"} busy={busy}
        disabled={disabled || opening || (!hasText && !state?.enabled)}
        onStop={onStop} onClick={hasText ? onSend : () => void open()} />
      {error && <span role="alert" className="absolute bottom-full right-0 mb-2 rounded-lg bg-background p-3 text-sm text-destructive">{error}</span>}
      {thread && state && <VoicePanel state={state} threadId={thread} surfaceRef={surfaceRef} onClose={async () => {
        setThread(null);
        await onEnd(thread);
      }} />}
    </>
  );
}
