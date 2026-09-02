"use client";

import { useState, useTransition } from "react";
import { toast } from "@/lib/toast";
import { clearApiKey, getSettings } from "@/actions/settings";
import { AiKeyPanel } from "@/components/settings/ai-key-panel";
import { Button } from "@/components/ui/button";

type Settings = Awaited<ReturnType<typeof getSettings>>;

export function AiSettings({ initialSettings }: { initialSettings: Settings }) {
  const [settings, setSettings] = useState<Settings>(initialSettings);
  const [pending, start] = useTransition();

  async function refresh() {
    setSettings(await getSettings());
  }

  return (
    <section className="space-y-4 rounded-2xl border border-border/70 bg-card p-6">
      <AiKeyPanel
        variant="settings"
        providers={settings.providers}
        initialProvider={settings.aiProvider}
        initialModel={settings.aiModel}
        onVerified={() => start(refresh)}
      />

      <div className="border-t border-border/60 pt-4">
        <p className="mb-2 text-sm font-medium text-ink">Saved keys</p>
        <ul className="space-y-1.5 text-sm text-muted-foreground">
          {settings.providers.map((p) => (
            <li key={p.id} className="flex items-center justify-between gap-2">
              <span>
                {p.label}:{" "}
                {p.hasPersonalKey ? "saved" : p.usingEnv ? "local env" : "none"}
              </span>
              {p.hasPersonalKey && (
                <Button
                  type="button"
                  variant="outline"
                  size="xs"
                  disabled={pending}
                  onClick={() =>
                    start(async () => {
                      await clearApiKey(p.id);
                      await refresh();
                      toast.success(`${p.label} key cleared`);
                    })
                  }
                >
                  Clear personal key
                </Button>
              )}
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
