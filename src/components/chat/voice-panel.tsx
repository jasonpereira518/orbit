"use client";
import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Mic, MicOff, X, Captions, Loader2, MessageSquare } from "lucide-react";
import { VoiceOrbit } from "./voice/voice-orbit";
import { plainSpeech } from "./voice/voice-engine";
import { cn } from "@/lib/utils";
import "./voice/voice-overlay.css";
import { Button, buttonVariants } from "@/components/ui/button";
import { ProposedActionsCard } from "./proposed-actions";
import { VOICE_DURATION_SECONDS } from "@/lib/voice/policy";
import { PROVIDER_LABELS } from "@/lib/voice/config";
import { useVoiceCall, voiceActions, voiceControls } from "@/lib/voice/call-store";
import type { VoicePublicState } from "@/lib/voice/contracts";
/**
 * The live call's view. Inline in Chat's conversation column (`compact` false); a small card at
 * the middle right of every other page (`compact` true). `VoiceDock` owns where it sits, and
 * `VoiceEngine` owns the call itself, so this can move or remount without hanging up.
 */
export function VoicePanel({ state, compact = false }: { state: VoicePublicState; compact?: boolean }) {
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
      // Floating over another page, a stray Escape there must not hang up.
      if ((nowhere && !compact) || root.current?.contains(focus)) void voiceActions.close();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [compact]);
  const connected = active && mode !== "connecting" && mode !== "disconnected";
  const waiting = cards.some((card) => card.action.status === "proposed");
  const lastProvider = provider;
  return (
    <section
      aria-label="Orbit Voice"
      data-transcript={showTranscript || undefined}
      data-compact={compact || undefined}
      ref={root}
      className={cn(
        "voice-stage flex min-h-0 min-w-0 flex-col text-foreground",
        compact
          ? "w-[4.75rem] items-stretch rounded-[1.75rem] border border-border/70 bg-card px-2 py-3 shadow-lg"
          : "w-full flex-1 overflow-y-auto px-6 py-4 sm:px-10",
      )}
    >
      {/* One centred column: `m-auto` centres it in Chat's space, and unlike justify-center
          it still scrolls from the top when the transcript makes it taller than the page.
          Docked on another page it is a slim vertical card: orbit, a word of status, then
          icon buttons stacked, so it sits at the edge without covering the page. */}
      <div className={cn("flex w-full flex-col", !compact && "m-auto max-h-full min-h-0 max-w-2xl")}>
      <div className="flex min-h-0 flex-col items-center text-center">
        <div className={cn(compact && "sr-only")}>
          <h2 className="text-lg font-medium">Orbit Voice</h2>
          <p className="mt-2 text-sm text-muted-foreground">In this conversation · {PROVIDER_LABELS[provider]}</p>
        </div>
        <div className={cn("flex min-h-0 w-full items-center justify-center", compact ? "py-0.5" : "py-4 sm:py-6")}>
          <VoiceOrbit controls={voiceControls} mode={mode} muted={muted} />
        </div>
        <p role="status" className={compact ? "text-2xs leading-tight text-muted-foreground" : "min-h-6 text-sm text-muted-foreground"}>
          {busy
            ? "Connecting…"
            : mode === "speaking"
              ? compact ? "Speaking" : "Orbit is speaking · interrupt anytime"
              : mode === "thinking"
                ? compact ? "Thinking" : "Looking that up…"
                : connected
                  ? muted
                    ? compact ? "Muted" : "Microphone muted"
                    : compact ? "Listening" : "Listening…"
                  : compact ? "Ready" : "Ready when you are"}
        </p>
        <div className={cn("flex items-center justify-center", compact ? "mt-2 flex-col gap-2" : "mt-5 flex-wrap gap-3")}>
          {connected && (
            <Button
              size={compact ? "icon" : "sm"}
              variant="secondary"
              className={compact ? "size-10 rounded-full" : "h-11 rounded-full px-5"}
              aria-pressed={muted}
              aria-label={compact ? (muted ? "Unmute" : "Mute") : undefined}
              title={compact ? (muted ? "Unmute" : "Mute") : undefined}
              onClick={() => voiceActions.toggleMute()}
            >
              {muted ? (
                <MicOff className="size-4" aria-hidden />
              ) : (
                <Mic className="size-4" aria-hidden />
              )}
              {!compact && (muted ? "Unmute" : "Mute")}
            </Button>
          )}
          {!busy && !active && (
            <Button
              size={compact ? "icon" : "sm"}
              className={compact ? "size-10 rounded-full" : "h-11 rounded-full px-5"}
              aria-label={compact ? (error ? `Retry ${PROVIDER_LABELS[state.provider]}` : "Start conversation") : undefined}
              onClick={() => voiceActions.start()}
            >
              <Mic className="size-4" aria-hidden />
              {!compact && (error
                ? `Retry ${PROVIDER_LABELS[state.provider]}`
                : "Start conversation")}
            </Button>
          )}
          {compact ? (
            <Link
              href="/chat"
              aria-label={waiting ? "Open chat · a change is waiting for you to confirm" : "Open chat"}
              title={waiting ? "A change is waiting for you to confirm in Chat" : "Open chat"}
              className={cn(buttonVariants({ variant: "secondary", size: "icon" }), "relative size-10 rounded-full")}
            >
              <MessageSquare className="size-4" aria-hidden />
              {waiting && <span aria-hidden className="absolute right-0.5 top-0.5 size-2.5 rounded-full bg-primary ring-2 ring-card" />}
            </Link>
          ) : (
            <Button variant="secondary" className="h-11 rounded-full px-5" aria-expanded={showTranscript} aria-controls="voice-transcript" onClick={() => setShowTranscript(value => !value)}>
              <Captions className="size-4" aria-hidden /> Transcript
            </Button>
          )}
          {/* Ending a call is calm, not alarming: a quiet gray X, never a red phone. */}
          <Button
            variant="ghost"
            size="icon"
            aria-label="End conversation"
            title="End conversation"
            className={cn(compact ? "size-10" : "size-11", "rounded-full bg-muted text-muted-foreground hover:bg-muted/70 hover:text-foreground")}
            disabled={closing}
            onClick={() => void voiceActions.close()}
          >
            {closing ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <X className="size-5" aria-hidden />}
          </Button>
        </div>
      </div>
      {saveError && <div role="status" className={cn("text-center", compact ? "mt-2 text-2xs leading-tight" : "mt-4 text-sm")}>
        {compact ? "Transcript not saved yet." : "Some transcript turns haven’t saved yet. Keep this window open."}
        <Button variant="link" size={compact ? "sm" : "default"} className={cn(compact && "h-auto px-0 text-2xs")} onClick={() => void voiceActions.retrySaves()}>Retry saving</Button>
      </div>}
      {!active && !compact && (
        <p className="mt-2 text-center text-xs text-muted-foreground">
          Your audio and relevant CRM context are processed by{" "}
          {PROVIDER_LABELS[state.provider]}. App sessions end after{" "}
          {VOICE_DURATION_SECONDS / 60} minutes.
        </p>
      )}
      {error && (
        <div className={cn("space-y-2 text-center", compact ? "mt-2" : "mt-3")}>
          <p role="alert" className={compact ? "text-2xs leading-tight text-destructive" : "text-sm text-destructive"}>
            {error}
          </p>
          {failed &&
            !active &&
            state.fallbackProvider &&
            lastProvider === state.provider && (
              <Button
                size="sm"
                variant="outline"
                className={cn(compact && "h-auto w-full whitespace-normal px-1 py-1 text-2xs")}
                onClick={() => voiceActions.start(true)}
              >
                Try {PROVIDER_LABELS[state.fallbackProvider]}
              </Button>
            )}
        </div>
      )}
      {showTranscript && !compact && (
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
                {line.source === "user" ? "You" : "Orbit"}
              </span>
              <span className="whitespace-pre-wrap [overflow-wrap:anywhere]">
                {plainSpeech(line.text)}
                {line.interrupted && <span className="ml-2 text-muted-foreground">(interrupted)</span>}
              </span>
            </p>
          ))}
        </div>
      )}
      {!compact && (
        <div className="mx-auto w-full max-w-2xl">
          {cards.map((card) => (
            <ProposedActionsCard
              key={card.action.id}
              {...card}
              onSettled={(next) => voiceActions.settleCard(next)}
            />
          ))}
        </div>
      )}
      </div>
    </section>
  );
}
