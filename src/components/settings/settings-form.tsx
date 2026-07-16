"use client";

import { useEffect, useState, useTransition } from "react";
import { toast } from "sonner";
import {
  clearApiKey,
  deleteAllData,
  exportAllData,
  getSettings,
  saveApiKey,
} from "@/actions/settings";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export function SettingsForm() {
  const [settings, setSettings] = useState<Awaited<ReturnType<typeof getSettings>> | null>(
    null
  );
  const [apiKey, setApiKey] = useState("");
  const [model, setModel] = useState("gpt-4o-mini");
  const [pending, start] = useTransition();

  useEffect(() => {
    getSettings().then((s) => {
      setSettings(s);
      setModel(s.aiModel);
    });
  }, []);

  return (
    <div className="space-y-8">
      <section className="space-y-4 rounded-2xl border border-border/70 bg-white p-6">
        <div>
          <h2 className="text-lg font-medium text-[#0f3d3e]">AI provider</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Bring your own OpenAI key (encrypted at rest). Or set{" "}
            <code className="text-xs">OPENAI_API_KEY</code> on the server for demos.
          </p>
        </div>
        {settings && (
          <p className="text-sm text-muted-foreground">
            Status:{" "}
            {settings.hasApiKey
              ? "Personal key saved"
              : settings.usingEnvKey
                ? "Using server env key"
                : "No key configured"}
          </p>
        )}
        <div className="space-y-1.5">
          <Label htmlFor="key">OpenAI API key</Label>
          <Input
            id="key"
            type="password"
            placeholder="sk-..."
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="model">Model</Label>
          <Input
            id="model"
            value={model}
            onChange={(e) => setModel(e.target.value)}
          />
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            disabled={pending || !apiKey.trim()}
            className="bg-[#0f3d3e] hover:bg-[#0c3233]"
            onClick={() =>
              start(async () => {
                await saveApiKey(apiKey, model);
                setApiKey("");
                setSettings(await getSettings());
                toast.success("API key saved");
              })
            }
          >
            Save key
          </Button>
          <Button
            variant="outline"
            disabled={pending}
            onClick={() =>
              start(async () => {
                await clearApiKey();
                setSettings(await getSettings());
                toast.success("Key cleared");
              })
            }
          >
            Clear personal key
          </Button>
        </div>
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
              if (!confirm("Delete ALL your Orbit data? This cannot be undone.")) return;
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
