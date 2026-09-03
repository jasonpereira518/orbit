"use client";

import { type FormEvent, useId, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Check, ChevronDown, Loader2 } from "lucide-react";
import { toast } from "@/lib/toast";
import { saveAiSettings, verifyAndSaveAiKey } from "@/actions/settings";
import {
  AI_PROVIDERS,
  DEFAULT_MODELS,
  PROVIDER_MODELS,
  type AiProvider,
} from "@/lib/ai-providers";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { GeminiKeyGuide } from "@/components/settings/gemini-key-guide";
import { cn } from "@/lib/utils";

const SELECT_CLASSES =
  "flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50";

/** Anthropic has no embeddings API — reworded from ai-settings.tsx's original note. */
const ANTHROPIC_EMBEDDING_NOTE =
  "Anthropic can't power search. Keep a Gemini or OpenAI key too so Chat can find people.";

type ProviderStatus = {
  id: AiProvider;
  label: string;
  hasPersonalKey: boolean;
  usingEnv: boolean;
};

type CheckStatus = "idle" | "saved" | "error";

export function AiKeyPanel({
  variant,
  initialProvider,
  initialModel,
  providers,
  onVerified,
  onSkip,
  className,
}: {
  variant: "settings" | "inline" | "wizard";
  initialProvider?: AiProvider;
  initialModel?: string;
  /** Only the settings variant renders a status line, and only when this is passed. */
  providers?: ProviderStatus[];
  onVerified?: (r: { provider: AiProvider; model: string }) => void;
  /** wizard variant renders a ghost "Skip for now" that calls this. */
  onSkip?: () => void;
  className?: string;
}) {
  const router = useRouter();
  // Multiple instances can be mounted at once (e.g. the chat empty state and a
  // simultaneously-open capture sheet) — ids must be unique per instance.
  const uid = useId();
  const [provider, setProvider] = useState<AiProvider>(
    initialProvider ?? "gemini"
  );
  const [apiKey, setApiKey] = useState("");
  const [model, setModel] = useState(
    initialModel ?? DEFAULT_MODELS[initialProvider ?? "gemini"]
  );
  const [customModel, setCustomModel] = useState(
    !PROVIDER_MODELS[initialProvider ?? "gemini"].some(
      (m) => m.value === model
    )
  );
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [checkStatus, setCheckStatus] = useState<CheckStatus>("idle");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const providerMeta = AI_PROVIDERS.find((p) => p.id === provider)!;
  const models = PROVIDER_MODELS[provider];
  const activeProviderStatus = providers?.find((p) => p.id === provider);

  // Settings only: the active provider already has a key (personal or env) it can run with,
  // so leaving the key field blank and just changing the provider/model dropdowns should
  // still be savable — see `handleSaveSettings` below.
  const canSaveWithoutKey =
    variant === "settings" &&
    !apiKey.trim() &&
    Boolean(activeProviderStatus?.hasPersonalKey || activeProviderStatus?.usingEnv);

  function resetCheckState() {
    if (checkStatus !== "idle") {
      setCheckStatus("idle");
      setErrorMessage(null);
    }
  }

  function handleVerify() {
    const key = apiKey.trim();
    if (!key || pending) return;
    start(async () => {
      try {
        const res = await verifyAndSaveAiKey({ provider, apiKey: key, model });
        if (!res.ok) {
          setCheckStatus("error");
          setErrorMessage(res.message);
          return;
        }
        setCheckStatus("saved");
        setErrorMessage(null);
        setApiKey("");
        toast.success("AI is on");
        onVerified?.({ provider: res.provider, model: res.model });
        router.refresh();
      } catch (err) {
        setCheckStatus("error");
        setErrorMessage(
          err instanceof Error ? err.message : "Something went wrong. Try again."
        );
      }
    });
  }

  /** Saves the provider/model selection alone, keeping whatever key is already on file —
   *  the settings-only path for switching model or active provider without re-pasting a key. */
  function handleSaveSettings() {
    if (pending) return;
    start(async () => {
      try {
        await saveAiSettings({ provider, model });
        setCheckStatus("saved");
        setErrorMessage(null);
        toast.success("AI settings saved");
        onVerified?.({ provider, model });
        router.refresh();
      } catch (err) {
        setCheckStatus("error");
        setErrorMessage(
          err instanceof Error ? err.message : "Something went wrong. Try again."
        );
      }
    });
  }

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (canSaveWithoutKey) {
      handleSaveSettings();
    } else {
      handleVerify();
    }
  }

  return (
    <div
      className={cn(
        "space-y-4",
        variant !== "settings" &&
          "rounded-2xl border border-border/70 bg-card p-5",
        className
      )}
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-medium text-ink">
            {variant === "settings" ? "AI key" : "Turn on AI"}
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Gemini is free to get and takes about a minute.
          </p>
        </div>
        <GeminiKeyGuide />
      </div>

      {activeProviderStatus && (
        <p className="text-sm text-muted-foreground">
          Status:{" "}
          {activeProviderStatus.hasPersonalKey
            ? "Your key is saved"
            : activeProviderStatus.usingEnv
              ? "Using a local key (dev only)"
              : "No key yet — paste one below to enable AI features"}
        </p>
      )}

      <form onSubmit={handleSubmit} className="space-y-4">
        <div className="space-y-1.5">
          <Label htmlFor={`${uid}-key`}>{providerMeta.label} API key</Label>
          <Input
            id={`${uid}-key`}
            type="password"
            autoComplete="off"
            placeholder={providerMeta.keyPlaceholder}
            value={apiKey}
            onChange={(e) => {
              setApiKey(e.target.value);
              resetCheckState();
            }}
          />
          {checkStatus === "error" && errorMessage && (
            <p role="alert" className="text-sm text-destructive">
              {errorMessage}
            </p>
          )}
        </div>

        <div className="flex flex-wrap gap-2">
          <Button
            type="submit"
            disabled={pending || (!apiKey.trim() && !canSaveWithoutKey)}
            className="bg-primary text-primary-foreground hover:bg-primary/90"
          >
            {pending ? (
              <>
                <Loader2 className="size-4 animate-spin" />
                {canSaveWithoutKey ? "Saving…" : "Verifying…"}
              </>
            ) : checkStatus === "saved" ? (
              <>
                <Check className="size-4" />
                Saved
              </>
            ) : canSaveWithoutKey ? (
              "Save settings"
            ) : (
              "Verify and save"
            )}
          </Button>
          {variant === "wizard" && onSkip && (
            <Button type="button" variant="ghost" onClick={onSkip}>
              Skip for now
            </Button>
          )}
        </div>
      </form>

      <details
        className="group rounded-lg border border-border/60"
        open={advancedOpen}
        onToggle={(e) => setAdvancedOpen(e.currentTarget.open)}
      >
        <summary className="flex cursor-pointer list-none items-center justify-between gap-2 px-3 py-2 text-sm font-medium text-foreground [&::-webkit-details-marker]:hidden">
          Advanced
          <ChevronDown className="size-4 shrink-0 text-muted-foreground transition-transform group-open:rotate-180" />
        </summary>
        <div className="space-y-4 border-t border-border/60 px-3 pb-3 pt-3">
          <div className="space-y-1.5">
            <Label htmlFor={`${uid}-provider`}>Provider</Label>
            <select
              id={`${uid}-provider`}
              className={SELECT_CLASSES}
              value={provider}
              onChange={(e) => {
                const next = e.target.value as AiProvider;
                setProvider(next);
                setApiKey("");
                setModel(DEFAULT_MODELS[next]);
                setCustomModel(false);
                resetCheckState();
              }}
            >
              {AI_PROVIDERS.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label}
                </option>
              ))}
            </select>
          </div>

          {provider === "anthropic" && (
            <p className="rounded-xl bg-muted/50 p-3 text-sm text-muted-foreground">
              {ANTHROPIC_EMBEDDING_NOTE}
            </p>
          )}

          <div className="space-y-1.5">
            <Label htmlFor={`${uid}-model`}>Model</Label>
            {!customModel ? (
              <select
                id={`${uid}-model`}
                className={SELECT_CLASSES}
                value={model}
                onChange={(e) => {
                  if (e.target.value === "__custom__") {
                    setCustomModel(true);
                    resetCheckState();
                    return;
                  }
                  setModel(e.target.value);
                  resetCheckState();
                }}
              >
                {models.map((m) => (
                  <option key={m.value} value={m.value}>
                    {m.label}
                  </option>
                ))}
                <option value="__custom__">Custom model ID…</option>
              </select>
            ) : (
              <div className="flex gap-2">
                <Input
                  id={`${uid}-model`}
                  value={model}
                  onChange={(e) => setModel(e.target.value)}
                  placeholder="model-id"
                />
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => {
                    setCustomModel(false);
                    setModel(DEFAULT_MODELS[provider]);
                  }}
                >
                  Presets
                </Button>
              </div>
            )}
          </div>
        </div>
      </details>
    </div>
  );
}
