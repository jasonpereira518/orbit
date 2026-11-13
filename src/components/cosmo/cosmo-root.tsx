"use client";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Captions, Loader2, MessageSquare, Mic, MicOff, X } from "lucide-react";
import { setCaptions, useCaptions } from "@/lib/cosmo/captions-pref";
import { CosmoCaption } from "./cosmo-caption";
import { Button, buttonVariants } from "@/components/ui/button";
import { ProposedActionsCard } from "@/components/chat/proposed-actions";
import { cn } from "@/lib/utils";
import { PROVIDER_LABELS } from "@/lib/voice/config";
import { animate, motion, useMotionValue } from "motion/react";
import { SPRING_SOFT } from "@/lib/motion";
import { usePrefersReducedMotion } from "@/lib/use-prefers-reduced-motion";
import { slotParts, stepSlot } from "@/lib/cosmo/placement";
import { useCosmoPlacement } from "./use-cosmo-placement";
import { openVoice, updateVoiceState, useVoiceDock } from "@/lib/voice/dock-store";
import { useVoiceCall, voiceActions } from "@/lib/voice/call-store";
import type { VoicePublicState } from "@/lib/voice/contracts";
import { useAppPulse } from "@/lib/app-pulse-store";
import { nudgeInput, pickNudge } from "@/lib/cosmo/nudge";
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

/** Nudges dismissed today, per device: a dismissed one stays gone until tomorrow. */
const NUDGES_KEY = "orbit:cosmo-nudges";
function readDismissed(): Set<string> {
  try {
    const saved = JSON.parse(localStorage.getItem(NUDGES_KEY) ?? "null") as { day?: string; ids?: unknown } | null;
    return new Set(saved?.day === today() && Array.isArray(saved.ids) ? saved.ids.filter((id) => typeof id === "string") : []);
  } catch {
    return new Set();
  }
}

/**
 * Cosmo in the bottom-right corner of every signed-in page: an idle orb to click and talk, and,
 * during a call off Chat, the call's docked bar with its cards and errors. On Chat, with the
 * call's slot present, the inline stage shows instead (VoiceDock). Toasts and the job stack sit
 * above it: the height published here is added to their offsets in theme.css.
 */
export function CosmoRoot({ tourActive = false }: { tourActive?: boolean }) {
  const pathname = usePathname();
  const { call, slot } = useVoiceDock();
  const [state, setState] = useState<VoicePublicState | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const probe = useRef<HTMLDivElement>(null);
  const { pulse } = useAppPulse();
  const [dismissed, setDismissed] = useState(readDismissed);
  // Minutes-until on the chip: a clock that ticks, not Date.now() in render.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(id);
  }, []);
  const nudge = pulse ? pickNudge(nudgeInput(pulse), now, dismissed) : null;
  const dismiss = (id: string) => {
    const next = new Set(dismissed).add(id);
    setDismissed(next);
    try {
      localStorage.setItem(NUDGES_KEY, JSON.stringify({ day: today(), ids: [...next] }));
    } catch {
      /* Private mode: dismissed for this page view only. */
    }
  };
  const talk = () => state && openVoice(dayThread(), state, "cosmo", nudge?.id);

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

  const hidden =
    tourActive || pathname.startsWith("/onboarding") || Boolean(call && slot) || (!call && !state?.enabled);
  /** Where Cosmo was just before it moves, so it glides from there (FLIP) instead of jumping. */
  const from = useRef<DOMRect | null>(null);
  const capture = useCallback(() => {
    if (!from.current && root.current) from.current = root.current.getBoundingClientRect();
  }, []);
  const place = useCosmoPlacement(root, probe, !hidden, capture);
  const { side, height } = slotParts(place.slot);
  const inCorner = place.slot === "bottom-right" && !place.collapsed;
  const reduced = usePrefersReducedMotion();
  const x = useMotionValue(0);
  const y = useMotionValue(0);
  const dragged = useRef(false);

  // Publish the corner Cosmo occupies so the job stack and toasts stack above it.
  useLayoutEffect(() => {
    const el = root.current;
    const html = document.documentElement;
    if (hidden || !inCorner || !el) return;
    const publish = () => html.style.setProperty("--orbit-cosmo-height", `${el.offsetHeight + 8}px`);
    publish();
    const observer = new ResizeObserver(publish);
    observer.observe(el);
    return () => {
      observer.disconnect();
      html.style.removeProperty("--orbit-cosmo-height");
    };
  }, [hidden, inCorner]);

  // A new slot: start from where it was, glide to the new place.
  useLayoutEffect(() => {
    const el = root.current;
    const start = from.current;
    from.current = null;
    if (!el) return;
    const now = el.getBoundingClientRect();
    const baseLeft = now.left - x.get();
    const baseTop = now.top - y.get();
    if (!start || reduced) {
      x.set(0);
      y.set(0);
      return;
    }
    // Keep the edge it hugs still: the right edge for right-side slots, the bottom for bottom ones.
    x.set(side === "right" ? start.right - (baseLeft + now.width) : start.left - baseLeft);
    y.set(height === "bottom" ? start.bottom - (baseTop + now.height) : start.top - baseTop);
    void animate(x, 0, SPRING_SOFT);
    void animate(y, 0, SPRING_SOFT);
  }, [place.slot, side, height, reduced, x, y]);

  if (hidden) return null;
  if (place.collapsed)
    return (
      <button
        type="button"
        aria-label="Show Cosmo"
        title="Show Cosmo"
        onClick={place.expand}
        data-side={side}
        className="cosmo-tab fixed top-1/2 z-[51] -translate-y-1/2"
      />
    );
  return (
    <>
      {/* Pinned to the shared corner, so its live insets (nav, lift, shift) can be read in px. */}
      <div
        ref={probe}
        aria-hidden
        className="pointer-events-none fixed size-0"
        style={{ right: "var(--orbit-toast-right)", bottom: "calc(var(--orbit-corner-bottom) + var(--cosmo-gap))" }}
      />
      <motion.div
        ref={root}
        // aria-live="off": Base UI's modal hides everything outside it from assistive tech except
        // live regions, so this keeps Cosmo reachable while a dialog is open.
        aria-live="off"
        data-cosmo-slot={place.slot}
        drag
        dragMomentum={false}
        dragElastic={0}
        onDragStart={() => {
          dragged.current = true;
          place.hold(true);
        }}
        onDragEnd={() => {
          if (root.current) {
            const rect = root.current.getBoundingClientRect();
            from.current = rect;
            place.drop(rect);
          }
          place.hold(false);
        }}
        onPointerEnter={() => place.hold(true)}
        onPointerLeave={() => place.hold(false)}
        // A drag that ends on a button must not press it.
        onClickCapture={(event) => {
          if (!dragged.current) return;
          dragged.current = false;
          event.preventDefault();
          event.stopPropagation();
        }}
        onPointerDown={() => {
          dragged.current = false;
        }}
        onKeyDown={(event) => {
          const target = event.target as HTMLElement;
          if (target.matches("input, textarea, select, [contenteditable='true']")) return;
          const next = stepSlot(place.home, event.key);
          if (!next) return;
          event.preventDefault();
          place.setHome(next);
        }}
        style={{
          x,
          y,
          ...(side === "right" ? { right: "var(--orbit-toast-right)" } : { left: "var(--cosmo-left, 0.75rem)" }),
          ...(height === "bottom"
            ? { bottom: "calc(var(--orbit-corner-bottom) + var(--cosmo-gap))" }
            : height === "top"
              ? { top: "var(--cosmo-top, 4.5rem)" }
              : { top: "50%", translate: "0 -50%" }),
        }}
        // Above dialogs (z-50) so it stays usable with one open; it steps aside instead of covering.
        className={cn(
          "cosmo-root pointer-events-none fixed z-[51] flex w-[min(20rem,calc(100vw-1.5rem))] gap-2",
          side === "right" ? "items-end" : "items-start",
          height === "top" ? "flex-col-reverse" : "flex-col",
        )}
      >
        {call ? (
          <CosmoLive state={call.state} />
        ) : (
          <div className={cn("flex items-center gap-2", side === "left" && "flex-row-reverse")}>
            {nudge && (
              <div className="cosmo-chip pointer-events-auto flex items-center rounded-full border bg-popover text-popover-foreground shadow-md">
                <button
                  type="button"
                  className="max-w-[13rem] truncate py-1.5 pl-3 pr-1 text-sm"
                  aria-label={`${nudge.chip}: ask Cosmo`}
                  onClick={talk}
                >
                  {nudge.chip}
                </button>
                <button
                  type="button"
                  className="mr-1 grid size-6 place-items-center rounded-full text-muted-foreground hover:bg-muted hover:text-foreground"
                  aria-label={`Dismiss: ${nudge.chip}`}
                  onClick={() => dismiss(nudge.id)}
                >
                  <X className="size-3.5" aria-hidden />
                </button>
              </div>
            )}
            <button
              type="button"
              className="cosmo-idle pointer-events-auto"
              data-nudge={nudge ? nudge.kind : undefined}
              aria-label="Talk to Cosmo"
              title="Talk to Cosmo · drag or use arrow keys to move"
              aria-keyshortcuts="ArrowLeft ArrowRight ArrowUp ArrowDown"
              onClick={talk}
            />
          </div>
        )}
      </motion.div>
    </>
  );
}

function CosmoLive({ state }: { state: VoicePublicState }) {
  const { provider, active, mode, busy, muted, error, failed, cards, saveError, closing } = useVoiceCall();
  const connected = active && mode !== "connecting" && mode !== "disconnected";
  const captions = useCaptions();
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
      {captions && active && <CosmoCaption />}
      <div className="pointer-events-auto flex items-center gap-1.5 rounded-full border border-border/70 bg-card py-1 pr-1.5 pl-1 shadow-lg">
        {/* Cosmo's one orb (cosmo-orb.tsx) flies here off Chat. */}
        <div data-cosmo-orb-slot="dock" className="size-11 shrink-0" />
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
        <Button
          size="icon"
          variant={captions ? "default" : "secondary"}
          className="size-9 rounded-full"
          aria-pressed={captions}
          aria-label="Captions"
          title={captions ? "Hide captions" : "Show captions"}
          onClick={() => setCaptions(!captions)}
        >
          <Captions className="size-4" aria-hidden />
        </Button>
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
