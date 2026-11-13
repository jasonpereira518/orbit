"use client";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Loader2, MessageSquare, Mic, MicOff, X } from "lucide-react";
import { Button, buttonVariants } from "@/components/ui/button";
import { VoiceOrbit } from "@/components/chat/voice/voice-orbit";
import { ProposedActionsCard } from "@/components/chat/proposed-actions";
import { cn } from "@/lib/utils";
import { PROVIDER_LABELS } from "@/lib/voice/config";
import { openVoice, updateVoiceState, useVoiceDock } from "@/lib/voice/dock-store";
import { useVoiceCall, voiceActions, voiceControls } from "@/lib/voice/call-store";
import type { VoicePublicState } from "@/lib/voice/contracts";
import "@/components/chat/voice/voice-overlay.css";
import "./cosmo.css";

/** The day's Cosmo thread, per device: one conversation a day, resumed on every click. */
const THREAD_KEY = "orbit:cosmo-thread";
const today = () => new Date().toLocaleDateString("en-CA");
function dayThread(): string | null {
  try {
    const saved = JSON.parse(localStorage.getItem(THREAD_KEY) ?? "null") as { day?: string; id?: string } | null;
    return saved?.day === today() && typeof saved.id === "string" ? saved.id : null;
  } catch {
    return null;
  }
}

/**
 * Cosmo in the bottom-right corner of every signed-in page: an idle orb to click and talk, and,
 * during a call off Chat, the call's docked bar with its cards and errors. On Chat, with the
 * call's slot present, the inline stage shows instead (VoiceDock). Toasts and the job stack sit
 * above it: the height published here is added to their offsets in theme.css.
 */
export function CosmoRoot() {
  const pathname = usePathname();
  const { call, slot } = useVoiceDock();
  const [state, setState] = useState<VoicePublicState | null>(null);
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let alive = true;
    async function check() {
      try {
        const response = await fetch("/api/voice", { cache: "no-store" });
        if (!response.ok) return void (alive && setState(null));
        const data = (await response.json()) as VoicePublicState;
        if (!alive) return;
        setState(data);
        updateVoiceState(data);
      } catch {
        // Offline or blocked: keep what we had; a live call owns its own cleanup.
      }
    }
    void check();
    const onVisible = () => document.visibilityState === "visible" && void check();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      alive = false;
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);

  useEffect(() => {
    if (call?.origin !== "cosmo" || !call.threadId) return;
    try {
      localStorage.setItem(THREAD_KEY, JSON.stringify({ day: today(), id: call.threadId }));
    } catch {
      /* Private mode: tomorrow simply starts a new thread. */
    }
  }, [call?.origin, call?.threadId]);

  const hidden = pathname.startsWith("/onboarding") || Boolean(call && slot) || (!call && !state?.enabled);

  // Publish the corner Cosmo occupies so the job stack and toasts stack above it.
  useLayoutEffect(() => {
    const el = root.current;
    const html = document.documentElement;
    if (hidden || !el) return;
    const publish = () => html.style.setProperty("--orbit-cosmo-height", `${el.offsetHeight + 8}px`);
    publish();
    const observer = new ResizeObserver(publish);
    observer.observe(el);
    return () => {
      observer.disconnect();
      html.style.removeProperty("--orbit-cosmo-height");
    };
  }, [hidden]);

  if (hidden) return null;
  return (
    // aria-live="off": Base UI's modal hides everything outside it from assistive tech except
    // live regions, so this keeps Cosmo reachable while a dialog is open.
    <div
      ref={root}
      aria-live="off"
      // Click-through except its own controls: the column is as wide as a card, the bar is not.
      className="pointer-events-none fixed right-(--orbit-toast-right) bottom-(--orbit-corner-bottom) z-40 flex w-[min(20rem,calc(100vw-1.5rem))] flex-col items-end gap-2"
    >
      {call ? (
        <CosmoLive state={call.state} />
      ) : (
        <button
          type="button"
          className="cosmo-idle pointer-events-auto"
          aria-label="Talk to Cosmo"
          title="Talk to Cosmo"
          onClick={() => state && openVoice(dayThread(), state, "cosmo")}
        />
      )}
    </div>
  );
}

function CosmoLive({ state }: { state: VoicePublicState }) {
  const { provider, active, mode, busy, muted, error, failed, cards, saveError, closing } = useVoiceCall();
  const connected = active && mode !== "connecting" && mode !== "disconnected";
  const status = busy
    ? "Connecting…"
    : mode === "speaking"
      ? "Speaking"
      : mode === "thinking"
        ? "Thinking"
        : connected
          ? muted
            ? "Muted"
            : "Listening"
          : "Ready";
  return (
    <section
      aria-label="Cosmo"
      className="cosmo-live flex w-full flex-col items-end gap-2"
      onKeyDown={(event) => {
        if (event.key === "Escape" && !event.defaultPrevented) void voiceActions.close();
      }}
    >
      {(error || saveError || cards.length > 0) && (
        <div className="pointer-events-auto flex max-h-[min(24rem,50dvh)] w-full flex-col gap-2 overflow-y-auto">
          {error && (
            <div className="rounded-xl border border-border/70 bg-card p-3 text-sm shadow-lg">
              <p role="alert" className="text-destructive">{error}</p>
              {failed && !active && state.fallbackProvider && provider === state.provider && (
                <Button size="sm" variant="outline" className="mt-2" onClick={() => voiceActions.start(true)}>
                  Try {PROVIDER_LABELS[state.fallbackProvider]}
                </Button>
              )}
            </div>
          )}
          {saveError && (
            <div role="status" className="rounded-xl border border-border/70 bg-card p-3 text-sm shadow-lg">
              Some of this conversation hasn’t saved yet.
              <Button variant="link" size="sm" className="h-auto px-1" onClick={() => void voiceActions.retrySaves()}>
                Retry saving
              </Button>
            </div>
          )}
          {cards.map((card) => (
            <ProposedActionsCard key={card.action.id} {...card} onSettled={(next) => voiceActions.settleCard(next)} />
          ))}
        </div>
      )}
      <div className="pointer-events-auto flex items-center gap-1.5 rounded-full border border-border/70 bg-card py-1 pr-1.5 pl-1 shadow-lg">
        <VoiceOrbit controls={voiceControls} mode={mode} muted={muted} />
        <p role="status" className="w-[4.75rem] text-xs text-muted-foreground">{status}</p>
        {connected && (
          <Button
            size="icon"
            variant="secondary"
            className="size-9 rounded-full"
            aria-pressed={muted}
            aria-label={muted ? "Unmute" : "Mute"}
            title={muted ? "Unmute" : "Mute"}
            onClick={() => voiceActions.toggleMute()}
          >
            {muted ? <MicOff className="size-4" aria-hidden /> : <Mic className="size-4" aria-hidden />}
          </Button>
        )}
        {!busy && !active && (
          <Button
            size="icon"
            className="size-9 rounded-full"
            aria-label={error ? `Retry ${PROVIDER_LABELS[state.provider]}` : "Start conversation"}
            onClick={() => voiceActions.start()}
          >
            <Mic className="size-4" aria-hidden />
          </Button>
        )}
        <Link
          href="/chat"
          aria-label="Open chat"
          title="Open this conversation in Chat"
          className={cn(buttonVariants({ variant: "secondary", size: "icon" }), "size-9 rounded-full")}
        >
          <MessageSquare className="size-4" aria-hidden />
        </Link>
        <Button
          variant="ghost"
          size="icon"
          aria-label="End conversation"
          title="End conversation"
          className="size-9 rounded-full bg-muted text-muted-foreground hover:bg-muted/70 hover:text-foreground"
          disabled={closing}
          onClick={() => void voiceActions.close()}
        >
          {closing ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <X className="size-4" aria-hidden />}
        </Button>
      </div>
    </section>
  );
}
