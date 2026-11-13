"use client";
import dynamic from "next/dynamic";
import { useEffect } from "react";
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

/**
 * Mounted once in the app layout so a call survives navigation. `VoiceEngine` (the call itself)
 * renders here, never portalled, so nothing a view does can hang up. Off Chat the call is
 * Cosmo's docked bar (CosmoRoot); on Chat, in the call's own thread, Chat offers a slot and the
 * stage (VoicePanel) renders into it. `orb`: feature.cosmo is released for this account (the
 * idle orb, its nudges); a call from Chat's mic still docks as Cosmo's bar without it.
 */
export function VoiceDock({ orb = false, tourActive = false }: { orb?: boolean; tourActive?: boolean }) {
  const { call, slot } = useVoiceDock();
  // Load Chat's stage with the call, so flying into it never waits on (or blinks for) a download.
  const live = Boolean(call);
  useEffect(() => {
    if (live) void import("../voice-panel");
  }, [live]);
  return (
    <>
      {/* Keyed on the call, not its thread: a Cosmo call adopts its thread after it starts. */}
      {call && (
        <VoiceEngine
          key={call.id}
          state={call.state}
          threadId={call.threadId}
          origin={call.origin}
          nudge={call.nudge}
          cosmo={orb}
          onClose={async () => closeVoice()}
        />
      )}
      {call && slot && createPortal(<VoicePanel key={call.id} state={call.state} />, slot)}
      {/* Hidden while the guided tour runs: its rail and cursor use the same corners. */}
      <CosmoRoot tourActive={tourActive} orb={orb} />
      {call && <CosmoOrb />}
      {call && <CosmoPointer />}
    </>
  );
}
