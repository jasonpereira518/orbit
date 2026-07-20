"use client";

import { useEffect, useState, useTransition } from "react";
import { toast } from "sonner";
import {
  clearApiKey,
  deleteAllData,
  exportAllData,
  getSettings,
  saveAiSettings,
} from "@/actions/settings";
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

export function SettingsForm() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [provider, setProvider] = useState<AiProvider>("gemini");
  const [apiKey, setApiKey] = useState("");
  const [model, setModel] = useState(DEFAULT_MODELS.gemini);
  const [customModel, setCustomModel] = useState(false);
  const [pending, start] = useTransition();

  useEffect(() => {
    getSettings().then((s) => {
      setSettings(s);
      setProvider(s.aiProvider);
      setModel(s.aiModel);
      setCustomModel(
        !PROVIDER_MODELS[s.aiProvider].some((m) => m.value === s.aiModel)
      );
    });
  }, []);

  const providerMeta = AI_PROVIDERS.find((p) => p.id === provider)!;
  const models = PROVIDER_MODELS[provider];
  const activeProviderStatus = settings?.providers.find((p) => p.id === provider);

  return (
    <div className="space-y-8">
      <section className="space-y-4 rounded-2xl border border-border/70 bg-white p-6">
        <div>
          <h2 className="text-lg font-medium text-[#0f3d3e]">AI provider</h2>
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
              const nextDefault = DEFAULT_MODELS[next];
              setModel(nextDefault);
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
            className="bg-[#0f3d3e] hover:bg-[#0c3233]"
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

        {settings && (
          <div className="border-t border-border/60 pt-4">
            <p className="mb-2 text-sm font-medium text-[#0f3d3e]">
              Saved keys
            </p>
            <ul className="space-y-1 text-sm text-muted-foreground">
              {settings.providers.map((p) => (
                <li key={p.id}>
                  {p.label}:{" "}
                  {p.hasPersonalKey
                    ? "personal"
                    : p.usingEnv
                      ? "env"
                      : "none"}
                </li>
              ))}
            </ul>
          </div>
        )}
      </section>

      <section className="space-y-4 rounded-2xl border border-border/70 bg-white p-6">
        <div>
          <h2 className="text-lg font-medium text-[#0f3d3e]">Your data</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Export everything as JSON, or permanently delete your Orbit data.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            variant="outline"
            disabled={pending}
            onClick={() =>
              start(async () => {
                const data = await exportAllData();
                const blob = new Blob([JSON.stringify(data, null, 2)], {
                  type: "application/json",
                });
                const url = URL.createObjectURL(blob);
                const a = document.createElement("a");
                a.href = url;
                a.download = `orbit-export-${new Date().toISOString().slice(0, 10)}.json`;
                a.click();
                URL.revokeObjectURL(url);
                toast.success("Export downloaded");
              })
            }
          >
            Export JSON
          </Button>
          <Button
            variant="outline"
            className="text-destructive"
            disabled={pending}
            onClick={() => {
              if (!confirm("Delete ALL your Orbit data? This cannot be undone."))
                return;
              start(async () => {
                await deleteAllData();
                toast.success("All data deleted");
              });
            }}
          >
            Delete all data
          </Button>
        </div>
      </section>
    </div>
  );
}
