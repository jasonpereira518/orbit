"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";
import { clearApiKey, getSettings, saveAiSettings } from "@/actions/settings";
import {
  AI_PROVIDERS,
  DEFAULT_MODELS,
  PROVIDER_MODELS,
  type AiProvider,
} from "@/lib/ai-providers";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

type Settings = Awaited<ReturnType<typeof getSettings>>;

export function AiSettings({ initialSettings }: { initialSettings: Settings }) {
  const [settings, setSettings] = useState<Settings>(initialSettings);
  const [provider, setProvider] = useState<AiProvider>(initialSettings.aiProvider);
  const [apiKey, setApiKey] = useState("");
  const [model, setModel] = useState(initialSettings.aiModel);
  const [customModel, setCustomModel] = useState(
    !PROVIDER_MODELS[initialSettings.aiProvider].some(
      (m) => m.value === initialSettings.aiModel
    )
  );
  const [pending, start] = useTransition();

  const providerMeta = AI_PROVIDERS.find((p) => p.id === provider)!;
  const models = PROVIDER_MODELS[provider];
  const activeProviderStatus = settings.providers.find((p) => p.id === provider);

  return (
    <section className="space-y-4 rounded-2xl border border-border/70 bg-card p-6">
      <div>
        <h2 className="text-lg font-medium text-primary">AI provider</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Choose Gemini, OpenAI, or Anthropic. Paste your own API key (encrypted
          at rest), or rely on a server env key for demos.
        </p>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="provider">Provider</Label>
        <select
          id="provider"
          className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
          value={provider}
          onChange={(e) => {
            const next = e.target.value as AiProvider;
            setProvider(next);
            setApiKey("");
            setModel(DEFAULT_MODELS[next]);
            setCustomModel(false);
          }}
        >
          {AI_PROVIDERS.map((p) => (
            <option key={p.id} value={p.id}>
              {p.label}
            </option>
          ))}
        </select>
      </div>

      {activeProviderStatus && (
        <p className="text-sm text-muted-foreground">
          Status:{" "}
          {activeProviderStatus.hasPersonalKey
            ? "Personal key saved"
            : activeProviderStatus.usingEnv
              ? `Using server ${activeProviderStatus.envVar}`
              : "No key configured"}
        </p>
      )}

      {provider === "anthropic" && (
        <p className="rounded-xl bg-muted/50 p-3 text-sm text-muted-foreground">
          Anthropic has no embeddings API. Keep an OpenAI or Gemini key available
          so chat search can still embed contacts.
        </p>
      )}

      <div className="space-y-1.5">
        <Label htmlFor="key">{providerMeta.label} API key</Label>
        <Input
          id="key"
          type="password"
          placeholder={
            activeProviderStatus?.hasPersonalKey
              ? "•••••••• (leave blank to keep current)"
              : providerMeta.keyPlaceholder
          }
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
        />
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="model">Model</Label>
        {!customModel ? (
          <select
            id="model"
            className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
            value={model}
            onChange={(e) => {
              if (e.target.value === "__custom__") {
                setCustomModel(true);
                return;
              }
              setModel(e.target.value);
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
              id="model"
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

      <div className="flex flex-wrap gap-2">
        <Button
          disabled={
            pending ||
            (!apiKey.trim() &&
              !activeProviderStatus?.hasPersonalKey &&
              !activeProviderStatus?.usingEnv)
          }
          className="bg-primary text-primary-foreground hover:bg-primary/90"
          onClick={() =>
            start(async () => {
              try {
                const res = await saveAiSettings({
                  provider,
                  model,
                  apiKey: apiKey.trim() || undefined,
                });
                setApiKey("");
                setSettings(await getSettings());
                toast.success(
                  res.embeddingReset
                    ? "Settings saved. Search embeddings reset for the new provider."
                    : "AI settings saved"
                );
              } catch (err) {
                toast.error(
                  err instanceof Error ? err.message : "Failed to save"
                );
              }
            })
          }
        >
          Save settings
        </Button>
        <Button
          variant="outline"
          disabled={pending || !activeProviderStatus?.hasPersonalKey}
          onClick={() =>
            start(async () => {
              await clearApiKey(provider);
              setSettings(await getSettings());
              toast.success(`${providerMeta.label} key cleared`);
            })
          }
        >
          Clear personal key
        </Button>
      </div>

      <div className="border-t border-border/60 pt-4">
        <p className="mb-2 text-sm font-medium text-primary">Saved keys</p>
        <ul className="space-y-1 text-sm text-muted-foreground">
          {settings.providers.map((p) => (
            <li key={p.id}>
              {p.label}:{" "}
              {p.hasPersonalKey ? "personal" : p.usingEnv ? "env" : "none"}
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
