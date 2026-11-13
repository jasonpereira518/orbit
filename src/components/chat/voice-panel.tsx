"use client";
import { useEffect, useRef, useState } from "react";
import { Mic, MicOff, X, Captions, Loader2 } from "lucide-react";
import { plainSpeech } from "./voice/voice-engine";
import "./voice/voice-overlay.css";
import { Button } from "@/components/ui/button";
import { ProposedActionsCard } from "./proposed-actions";
import { VOICE_DURATION_SECONDS } from "@/lib/voice/policy";
import { PROVIDER_LABELS } from "@/lib/voice/config";
import { useVoiceCall, voiceActions } from "@/lib/voice/call-store";
import type { VoicePublicState } from "@/lib/voice/contracts";
/**
 * Cosmo's big stage in Chat's conversation column, while the call's thread is the open one.
 * Everywhere else the call is Cosmo's docked bar (cosmo-root.tsx). `VoiceDock` owns where this
 * sits, `VoiceEngine` owns the call itself, and Cosmo's one orb (cosmo-orb.tsx) flies in and out.
 */
export function VoicePanel({ state }: { state: VoicePublicState }) {
  const { provider, active, mode, busy, muted, error, failed, lines, cards, saveError, closing } = useVoiceCall();
  const [showTranscript, setShowTranscript] = useState(false);
  const panel = useRef<HTMLDivElement | null>(null);
  const follow = useRef(true);
  useEffect(() => {
    if (panel.current && follow.current) panel.current.scrollTop = panel.current.scrollHeight;
  }, [lines, cards]);
  const root = useRef<HTMLElement | null>(null);
  // The old dialog ended the call on Escape. Keep that, but only when focus is in the panel
  // or nowhere (a button that just unmounted drops it to <body>), never from another menu.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const focus = document.activeElement;
      if (event.key !== "Escape" || event.defaultPrevented) return;
      const nowhere = focus === document.body || focus === null;
      if (nowhere || root.current?.contains(focus)) void voiceActions.close();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);
  const connected = active && mode !== "connecting" && mode !== "disconnected";
  const lastProvider = provider;
  return (
    <section
      aria-label="Cosmo in this conversation"
      data-transcript={showTranscript || undefined}
      ref={root}
      className="voice-stage flex min-h-0 w-full min-w-0 flex-1 flex-col overflow-y-auto px-6 py-4 text-foreground sm:px-10"
    >
      {/* One centred column: `m-auto` centres it in Chat's space, and unlike justify-center
          it still scrolls from the top when the transcript makes it taller than the page. */}
      <div className="m-auto flex max-h-full min-h-0 w-full max-w-2xl flex-col">
      <div className="flex min-h-0 flex-col items-center text-center">
        <div>
          <h2 className="text-lg font-medium">Cosmo</h2>
          <p className="mt-2 text-sm text-muted-foreground">In this conversation · {PROVIDER_LABELS[provider]}</p>
        </div>
        <div className="flex min-h-0 w-full items-center justify-center py-4 sm:py-6">
          {/* Cosmo's one orb (cosmo-orb.tsx) flies into this space and out again. */}
          <div data-cosmo-orb-slot="stage" className="voice-orbit-slot" />
        </div>
        <p role="status" className="min-h-6 text-sm text-muted-foreground">
          {busy
            ? "Connecting…"
            : mode === "speaking"
              ? "Cosmo is speaking · interrupt anytime"
              : mode === "thinking"
                ? "Looking that up…"
                : connected
                  ? muted
                    ? "Microphone muted"
                    : "Listening…"
                  : "Ready when you are"}
        </p>
        <div className="mt-5 flex flex-wrap items-center justify-center gap-3">
          {connected && (
            <Button
              size="sm"
              variant="secondary"
              className="h-11 rounded-full px-5"
              aria-pressed={muted}
              onClick={() => voiceActions.toggleMute()}
            >
              {muted ? <MicOff className="size-4" aria-hidden /> : <Mic className="size-4" aria-hidden />}
              {muted ? "Unmute" : "Mute"}
            </Button>
          )}
          {!busy && !active && (
            <Button size="sm" className="h-11 rounded-full px-5" onClick={() => voiceActions.start()}>
              <Mic className="size-4" aria-hidden />
              {error ? `Retry ${PROVIDER_LABELS[state.provider]}` : "Start conversation"}
            </Button>
          )}
          <Button variant="secondary" className="h-11 rounded-full px-5" aria-expanded={showTranscript} aria-controls="voice-transcript" onClick={() => setShowTranscript(value => !value)}>
            <Captions className="size-4" aria-hidden /> Transcript
          </Button>
          {/* Ending a call is calm, not alarming: a quiet gray X, never a red phone. */}
          <Button
            variant="ghost"
            size="icon"
            aria-label="End conversation"
            title="End conversation"
            className="size-11 rounded-full bg-muted text-muted-foreground hover:bg-muted/70 hover:text-foreground"
            disabled={closing}
            onClick={() => void voiceActions.close()}
          >
            {closing ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <X className="size-5" aria-hidden />}
          </Button>
        </div>
      </div>
      {saveError && <div role="status" className="mt-4 text-center text-sm">
        Some transcript turns haven’t saved yet. Keep this window open.
        <Button variant="link" onClick={() => void voiceActions.retrySaves()}>Retry saving</Button>
      </div>}
      {!active && (
        <p className="mt-2 text-center text-xs text-muted-foreground">
          Your audio and relevant CRM context are processed by{" "}
          {PROVIDER_LABELS[state.provider]}. Calls end after{" "}
          {VOICE_DURATION_SECONDS / 60} minutes, or a quiet minute.
        </p>
      )}
      {error && (
        <div className="mt-3 space-y-2 text-center">
          <p role="alert" className="text-sm text-destructive">{error}</p>
          {failed &&
            !active &&
            state.fallbackProvider &&
            lastProvider === state.provider && (
              <Button size="sm" variant="outline" onClick={() => voiceActions.start(true)}>
                Try {PROVIDER_LABELS[state.fallbackProvider]}
              </Button>
            )}
        </div>
      )}
      {showTranscript && (
        <div
          id="voice-transcript"
          ref={panel}
          onScroll={(event) => {
            const el = event.currentTarget;
            follow.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
          }}
          role="log"
          aria-label="Live voice transcript"
          className="mx-auto mt-6 max-h-44 w-full max-w-2xl shrink-0 space-y-3 overflow-y-auto rounded-xl bg-muted p-4 text-sm"
        >
          {lines.length === 0 && <p className="text-muted-foreground">Your conversation will appear here.</p>}
          {lines.map((line, i) => (
            <p key={line.id || i}>
              <span className="mr-2 font-medium">
                {line.source === "user" ? "You" : "Cosmo"}
              </span>
              <span className="whitespace-pre-wrap [overflow-wrap:anywhere]">
                {plainSpeech(line.text)}
                {line.interrupted && <span className="ml-2 text-muted-foreground">(interrupted)</span>}
              </span>
            </p>
          ))}
        </div>
      )}
      <div className="mx-auto w-full max-w-2xl">
        {cards.map((card) => (
          <ProposedActionsCard
            key={card.action.id}
            {...card}
            onSettled={(next) => voiceActions.settleCard(next)}
          />
        ))}
      </div>
      </div>
    </section>
  );
}
