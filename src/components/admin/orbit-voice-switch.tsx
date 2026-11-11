"use client";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  setOrbitVoiceEnabled,
  saveOrbitVoiceConfig,
  checkOrbitVoiceProvider,
} from "@/actions/voice-admin";
import { toast } from "@/lib/toast";
import { friendlyError } from "@/lib/errors";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import {
  VOICE_PROVIDERS,
  PROVIDER_LABELS,
  DEEPGRAM_VOICES,
  DEEPGRAM_THINK_MODELS,
  ELEVEN_TTS_MODELS,
  type VoiceConfig,
  type VoiceProvider,
  type VoiceHealthMap,
} from "@/lib/voice/config";
const field =
  "mt-1 block h-9 w-full rounded-lg border border-border bg-background px-3 text-sm focus-visible:outline-2 focus-visible:outline-ring";
export function OrbitVoiceSwitch({
  enabled,
  configured,
  config,
  providers,
  health,
}: {
  enabled: boolean;
  configured: boolean;
  config: VoiceConfig;
  providers: Record<VoiceProvider, boolean>;
  health: VoiceHealthMap;
}) {
  const [draft, setDraft] = useState(config);
  const [pending, start] = useTransition();
  const router = useRouter();
  const dirty = JSON.stringify(draft) !== JSON.stringify(config);
  function run(task: () => Promise<void>, success: string) {
    start(async () => {
      try {
        await task();
        router.refresh();
        toast.success(success);
      } catch (err) {
        toast.error(
          friendlyError(
            err,
            "Couldn’t update voice settings — check the selected provider and try again",
          ),
        );
      }
    });
  }
  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-6">
        <div className="max-w-2xl space-y-2">
          <p className="text-sm font-medium">Enable Orbit Voice</p>
          <p className="text-sm text-muted-foreground">
            Talk to your network with {PROVIDER_LABELS[config.provider]}. CRM
            changes always need a confirmation click.
          </p>
          <p className="text-xs text-muted-foreground">
            Off by default. Settings apply to new requests immediately. Open
            conversations end within 15 seconds of a change. Text chat stays
            available.
          </p>
        </div>
        <button
          type="button"
          role="switch"
          aria-label="Enable Orbit Voice"
          aria-checked={enabled}
          disabled={pending || (!enabled && (!configured || dirty))}
          className={cn(
            "tap-target relative inline-flex h-6 w-11 shrink-0 items-center rounded-full border focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-ring disabled:opacity-60",
            enabled ? "border-primary/40 bg-primary" : "border-border bg-muted",
          )}
          onClick={() =>
            run(
              () => setOrbitVoiceEnabled(!enabled),
              enabled ? "Orbit Voice is off" : "Orbit Voice is on",
            )
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
      <form
        className="max-w-2xl space-y-4"
        onSubmit={(event) => {
          event.preventDefault();
          run(() => saveOrbitVoiceConfig(draft), "Voice settings saved");
        }}
      >
        <fieldset disabled={pending} className="grid gap-4 sm:grid-cols-2">
          <label className="text-sm font-medium">
            Voice provider
            <select
              aria-label="Voice provider"
              className={field}
              value={draft.provider}
              onChange={(e) =>
                setDraft({
                  ...draft,
                  provider: e.target.value as VoiceProvider,
                })
              }
            >
              <option value="deepgram">Deepgram (Default)</option>
              <option value="elevenlabs">ElevenLabs</option>
            </select>
          </label>
          <label className="text-sm font-medium">
            Fallback behavior
            <select
              aria-label="Fallback behavior"
              className={field}
              value={draft.fallback}
              onChange={(e) =>
                setDraft({
                  ...draft,
                  fallback: e.target.value as VoiceConfig["fallback"],
                })
              }
            >
              <option value="none">Retry selected provider only</option>
              <option value="offer-alternative">
                Offer alternative after a failure
              </option>
            </select>
          </label>
          {draft.provider === "deepgram" ? (
            <>
              <label className="text-sm font-medium">
                Listening model
                <select
                  aria-label="Listening model"
                  className={field}
                  value={draft.deepgram.listenModel}
                  onChange={(e) =>
                    setDraft({
                      ...draft,
                      deepgram: {
                        ...draft.deepgram,
                        listenModel: e.target
                          .value as VoiceConfig["deepgram"]["listenModel"],
                      },
                    })
                  }
                >
                  {["nova-3", "nova-2"].map((v) => (
                    <option key={v}>{v}</option>
                  ))}
                </select>
              </label>
              <label className="text-sm font-medium">
                Conversation model
                <select
                  aria-label="Conversation model"
                  className={field}
                  value={draft.deepgram.thinkModel}
                  onChange={(e) =>
                    setDraft({
                      ...draft,
                      deepgram: {
                        ...draft.deepgram,
                        thinkModel: e.target
                          .value as VoiceConfig["deepgram"]["thinkModel"],
                      },
                    })
                  }
                >
                  {DEEPGRAM_THINK_MODELS.map((v) => (
                    <option key={v}>{v}</option>
                  ))}
                </select>
              </label>
              <label className="text-sm font-medium sm:col-span-2">
                Voice
                <select
                  aria-label="Deepgram voice"
                  className={field}
                  value={draft.deepgram.voice}
                  onChange={(e) =>
                    setDraft({
                      ...draft,
                      deepgram: {
                        ...draft.deepgram,
                        voice: e.target
                          .value as VoiceConfig["deepgram"]["voice"],
                      },
                    })
                  }
                >
                  {DEEPGRAM_VOICES.map((v) => (
                    <option key={v}>{v}</option>
                  ))}
                </select>
              </label>
            </>
          ) : (
            <>
              <label className="text-sm font-medium">
                Speech model
                <select
                  aria-label="ElevenLabs speech model"
                  className={field}
                  value={draft.elevenlabs.ttsModel}
                  onChange={(e) =>
                    setDraft({
                      ...draft,
                      elevenlabs: {
                        ...draft.elevenlabs,
                        ttsModel: e.target
                          .value as VoiceConfig["elevenlabs"]["ttsModel"],
                      },
                    })
                  }
                >
                  {ELEVEN_TTS_MODELS.map((v) => (
                    <option key={v}>{v}</option>
                  ))}
                </select>
              </label>
              <label className="text-sm font-medium">
                Voice ID
                <input
                  aria-label="ElevenLabs voice ID"
                  className={field}
                  value={draft.elevenlabs.voiceId}
                  maxLength={64}
                  placeholder="Use the agent’s default voice"
                  onChange={(e) =>
                    setDraft({
                      ...draft,
                      elevenlabs: {
                        ...draft.elevenlabs,
                        voiceId: e.target.value,
                      },
                    })
                  }
                />
              </label>
            </>
          )}
        </fieldset>
        <p className="text-xs text-muted-foreground">
          Fallback never runs silently. Users must choose the alternative, and
          it must have server credentials. Model and voice changes use the same
          account-scoped CRM tools.
        </p>
        <Button type="submit" size="sm" disabled={pending || !dirty}>
          {pending ? "Saving…" : "Save voice settings"}
        </Button>
      </form>
      <div className="space-y-3 border-t border-border pt-4">
        <h3 className="text-sm font-medium">Provider status</h3>
        {VOICE_PROVIDERS.map((provider) => (
          <div
            key={provider}
            className="flex flex-wrap items-center justify-between gap-3 text-sm"
          >
            <div>
              <p className="font-medium">
                {PROVIDER_LABELS[provider]} ·{" "}
                {providers[provider] ? "Configured" : "Not configured"}
              </p>
              <p className="mt-1 text-xs text-muted-foreground">
                {!providers[provider]
                  ? provider === "deepgram"
                    ? "Set DEEPGRAM_API_KEY and allow Deepgram in this deployment."
                    : "Set ELEVENLABS_API_KEY and ELEVENLABS_AGENT_ID for a private agent."
                  : !health[provider]
                    ? "Credentials haven’t been checked yet."
                    : `${health[provider]?.status === "ready" ? "Credential check passed" : "Last check or connection failed"} · ${health[provider]?.checkedAt.replace("T", " ").slice(0, 19)} UTC`}
              </p>
            </div>
            <Button
              size="sm"
              variant="outline"
              disabled={pending || !providers[provider]}
              onClick={() =>
                start(async () => {
                  try {
                    const out = await checkOrbitVoiceProvider(provider);
                    router.refresh();
                    if (out.ok) toast.success("Provider credentials verified");
                    else
                      toast.error(
                        "Couldn’t verify provider credentials — review server configuration",
                      );
                  } catch (err) {
                    toast.error(
                      friendlyError(
                        err,
                        "Couldn’t check the provider — try again?",
                      ),
                    );
                  }
                })
              }
            >
              Check {PROVIDER_LABELS[provider]}
            </Button>
          </div>
        ))}
        <p className="text-xs text-muted-foreground">
          Checks verify API credentials and agent configuration without starting
          a paid audio call. A successful check does not guarantee every audio
          connection.
        </p>
      </div>
      <p className="max-w-2xl text-xs text-muted-foreground">
        Orbit pays provider usage. Up to six starts per account and 100 starts
        across Orbit per day, with a ten-minute app session limit. Audio
        connection time is estimated below; billing remains in each provider’s
        console.
      </p>
    </div>
  );
}
