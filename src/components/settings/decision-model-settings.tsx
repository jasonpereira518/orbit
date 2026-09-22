"use client";

import { useState, useTransition } from "react";
import { toast } from "@/lib/toast";
import { clearDecisionKey, getSettings, saveDecisionKey } from "@/actions/settings";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { SettingsRow, SettingsSection } from "@/components/settings/settings-section";
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
      description="Add a TypeSafe key and Orbit hands its yes-or-no and ranking steps to Jev, TypeSafe’s decision model: spotting recruiters during a mail scan, and choosing which contacts a chat answer draws on. It answers in a fraction of a second, costs far less than a chat model, and runs on your own TypeSafe account. Keys are encrypted at rest and only used for your account."
    >
      <p className="text-sm text-muted-foreground" role="status">
        Status: {status}
      </p>

      <SettingsRow title="What Jev reads">
        <p className="text-sm text-muted-foreground">
          During a recruiter scan, each sender’s name, address, subject lines and message text —
          the same mail your chat model reads there today. When chat ranks contacts, a short card
          for each candidate: name, title, company, school, tags and summary.
        </p>
      </SettingsRow>

      <div className="space-y-1.5">
        <Label htmlFor="typesafe-key">TypeSafe API key</Label>
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
