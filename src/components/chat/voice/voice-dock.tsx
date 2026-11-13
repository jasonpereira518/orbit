"use client";
import dynamic from "next/dynamic";
import { useLayoutEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { closeVoice, useVoiceDock } from "@/lib/voice/dock-store";

// Both lazy: this dock is in every page's layout, and the call code is only needed on a call.
const VoiceEngine = dynamic(() => import("./voice-engine").then((m) => m.VoiceEngine), { ssr: false });
const CosmoPointer = dynamic(() => import("@/components/cosmo/cosmo-pointer").then((m) => m.CosmoPointer), { ssr: false });
const CosmoOrb = dynamic(() => import("@/components/cosmo/cosmo-orb").then((m) => m.CosmoOrb), { ssr: false });
const CosmoRoot = dynamic(() => import("@/components/cosmo/cosmo-root").then((m) => m.CosmoRoot), { ssr: false });
const VoicePanel = dynamic(
  () => import("../voice-panel").then((m) => m.VoicePanel),
  { ssr: false },
);

// One dock per page, so one host. `display: contents` lets the panel itself be the slot's
// flex child, wherever the host is moved.
let hostEl: HTMLDivElement | null = null;
function voiceHost() {
  if (!hostEl) {
    hostEl = document.createElement("div");
    hostEl.style.display = "contents";
  }
  return hostEl;
}

/**
 * Mounted once in the app layout so an Orbit Voice call survives navigation. `VoiceEngine` (the
 * call itself) renders here, never portalled, so nothing a view does can hang up. The panel
 * (the view) is portalled into ONE detached host element, moved between the chat page's slot
 * (inline) and the fixed middle-right dock (every other tab), which keeps the view's own state
 * (transcript open, scroll) across the move.
 */
export function VoiceDock({ cosmo = false, tourActive = false }: { cosmo?: boolean; tourActive?: boolean }) {
  const { call, slot } = useVoiceDock();
  const floating = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    // With Cosmo, off Chat the call is Cosmo's docked bar; the panel only renders in Chat's slot.
    const parent = cosmo ? slot : (slot ?? floating.current);
    if (!call || !parent) return;
    const host = voiceHost();
    if (host.parentElement !== parent) parent.appendChild(host);
  }, [call, slot, cosmo]);
  const showPanel = Boolean(call && (!cosmo || slot));
  return (
    <>
      <div
        ref={floating}
        className={
          call && !slot && !cosmo
            ? "fixed right-4 top-1/2 z-40 -translate-y-1/2"
            : "hidden"
        }
      />
      {/* Keyed on the call, not its thread: a Cosmo call adopts its thread after it starts. */}
      {call && (
        <VoiceEngine
          key={call.id}
          state={call.state}
          threadId={call.threadId}
          origin={call.origin}
          nudge={call.nudge}
          cosmo={cosmo}
          onClose={async () => closeVoice()}
        />
      )}
      {call && showPanel &&
        createPortal(<VoicePanel key={call.id} state={call.state} compact={!slot} cosmo={cosmo} />, voiceHost())}
      {/* Hidden while the guided tour runs: its rail and cursor use the same corners. */}
      {cosmo && <CosmoRoot tourActive={tourActive} />}
      {cosmo && call && <CosmoOrb />}
      {cosmo && call && <CosmoPointer />}
    </>
  );
}
