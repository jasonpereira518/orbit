"use client";

import { useState, useTransition } from "react";
import { ExternalLink } from "lucide-react";
import { toast } from "@/lib/toast";
import { clearDecisionKey, getSettings, saveDecisionKey } from "@/actions/settings";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { SettingsSection } from "@/components/settings/settings-section";
import { friendlyError } from "@/lib/errors";
import { TOAST_COPY } from "@/lib/toast-copy";

type Settings = Awaited<ReturnType<typeof getSettings>>;

/**
 * The optional TypeSafe key, for Jev — the decision model behind the yes/no and ranking steps
 * (`src/lib/decisions/`). Its own card rather than a fourth entry in the provider picker:
 * it is not a chat model, nobody "switches" to it, and it runs beside whichever provider is
 * picked above. With no key saved nothing changes, so the copy never implies one is needed.
 */
export function DecisionModelSettings({ initialSettings }: { initialSettings: Settings }) {
  const [state, setState] = useState(initialSettings.decisionModel);
  const [seenInitial, setSeenInitial] = useState(initialSettings);
  if (seenInitial !== initialSettings) {
    setSeenInitial(initialSettings);
    setState(initialSettings.decisionModel);
  }
  const [apiKey, setApiKey] = useState("");
  const [keyError, setKeyError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  // Without Jev each step runs exactly as it did before: some on your chat model, some on
  // Orbit's own rules (keyword filters, name matching). So the copy says "as before", not
  // "on your chat model", which was only true of some of them.
  const status = state.switchedOff
    ? "Switched off on this server — these steps run as they did before Jev"
    : state.keySaved
      ? "Your TypeSafe key is saved — Jev is handling these steps"
      : "No key — these steps run as they always have";

  return (
    <SettingsSection
      title="Decision model (optional)"
      description="Jev is TypeSafe’s decision model — it handles small yes-or-no and ranking steps Orbit would otherwise do on your chat model. It’s optional, and nothing changes until you add a key below."
    >
      <p className="text-sm text-muted-foreground" role="status">
        Status: {status}
      </p>

      <div className="space-y-1.5">
        <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
          <Label htmlFor="typesafe-key">TypeSafe API key</Label>
          {/*
            TypeSafe's own console, the host its homepage signs people in at. Linked at the
            root rather than a keys page: what sits behind that sign-in cannot be checked from
            here, and a deep link that has moved is worse than one more click.
          */}
          <a
            href="https://console.typesafe.ai/"
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 py-1 text-sm text-muted-foreground underline underline-offset-4 hover:text-foreground"
          >
            Get a key
            <ExternalLink className="size-3.5" aria-hidden />
          </a>
        </div>
        <Input
          id="typesafe-key"
          type="password"
          autoComplete="off"
          placeholder={state.keySaved ? "•••••••• (leave blank to keep current)" : "Paste your TypeSafe key"}
          value={apiKey}
          aria-invalid={keyError ? true : undefined}
          aria-describedby={keyError ? "typesafe-key-error" : undefined}
          onChange={(e) => {
            setApiKey(e.target.value);
            setKeyError(null);
          }}
        />
        {keyError && (
          <p id="typesafe-key-error" role="alert" className="text-sm text-destructive">
            {keyError}
          </p>
        )}
      </div>

      <div className="flex flex-wrap gap-2">
        <Button
          disabled={pending || !apiKey.trim()}
          className="bg-primary text-primary-foreground hover:bg-primary/90"
          onClick={() =>
            start(async () => {
              try {
                const res = await saveDecisionKey(apiKey);
                if (!res.ok) {
                  setKeyError(res.error);
                  return;
                }
                setKeyError(null);
                setApiKey("");
                setState((await getSettings()).decisionModel);
                toast.success(res.keyNote ?? "TypeSafe key saved");
              } catch (err) {
                toast.error(friendlyError(err, TOAST_COPY.saveFailed));
              }
            })
          }
        >
          Save key
        </Button>
        <Button
          variant="outline"
          disabled={pending || !state.keySaved}
          onClick={() =>
            start(async () => {
              try {
                await clearDecisionKey();
                setState((await getSettings()).decisionModel);
                toast.success("TypeSafe key cleared");
              } catch (err) {
                toast.error(friendlyError(err, TOAST_COPY.saveFailed));
              }
            })
          }
        >
          Clear key
        </Button>
      </div>
    </SettingsSection>
  );
}
