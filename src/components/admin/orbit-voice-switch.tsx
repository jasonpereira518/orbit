"use client";
import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { setOrbitVoiceEnabled } from "@/actions/voice-admin";
import { toast } from "@/lib/toast";
import { friendlyError } from "@/lib/errors";
import { cn } from "@/lib/utils";
export function OrbitVoiceSwitch({
  enabled,
  configured,
}: {
  enabled: boolean;
  configured: boolean;
}) {
  const [pending, start] = useTransition();
  const router = useRouter();
  return (
    <div className="flex items-start justify-between gap-6">
      <div className="max-w-2xl space-y-2">
        <p className="text-sm font-medium">Conversational CRM assistant</p>
        <p className="text-sm text-muted-foreground">
          Let users talk to their network with ElevenLabs. Lookups use their own
          CRM records; changes need a confirmation click. Text chat stays
          available.
        </p>
        <p className="text-xs text-muted-foreground">
          Off by default. Changes apply to new requests immediately; open chat
          pages refresh within 15 seconds. Up to six ten-minute sessions per
          account per day, and 100 starts across Orbit per day. ElevenLabs usage
          is billed to Orbit.
        </p>
        {!configured && (
          <p className="text-xs text-muted-foreground">
            Set ELEVENLABS_API_KEY and ELEVENLABS_AGENT_ID for a private agent
            before enabling.
          </p>
        )}
      </div>
      <button
        type="button"
        role="switch"
        aria-label="Orbit Voice"
        aria-checked={enabled}
        disabled={pending || (!enabled && !configured)}
        className={cn(
          "tap-target relative inline-flex h-6 w-11 shrink-0 items-center rounded-full border focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-ring disabled:opacity-60",
          enabled ? "border-primary/40 bg-primary" : "border-border bg-muted",
        )}
        onClick={() =>
          start(async () => {
            try {
              await setOrbitVoiceEnabled(!enabled);
              router.refresh();
              toast.success(
                enabled ? "Orbit Voice is off" : "Orbit Voice is on",
              );
            } catch (err) {
              toast.error(
                friendlyError(err, "Couldn’t change Orbit Voice — try again?"),
              );
            }
          })
        }
      >
        <span
          aria-hidden
          className={cn(
            "inline-block size-4.5 rounded-full bg-background shadow",
            enabled ? "translate-x-[1.35rem]" : "translate-x-0.5",
          )}
        />
      </button>
    </div>
  );
}
