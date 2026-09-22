"use client";

import { useState, useSyncExternalStore } from "react";
import { Check, Copy, ExternalLink } from "lucide-react";
import { Button, buttonVariants } from "@/components/ui/button";
import { SettingsSection } from "@/components/settings/settings-section";
import { toast } from "@/lib/toast";
import { TOAST_COPY } from "@/lib/toast-copy";
import { cn } from "@/lib/utils";

type Assistant = "claude" | "chatgpt";

const ASSISTANTS: Record<
  Assistant,
  { label: string; settingsHref: string; settingsLabel: string; steps: readonly string[] }
> = {
  claude: {
    label: "Claude",
    settingsHref: "https://claude.ai/settings/connectors",
    settingsLabel: "Open Claude",
    steps: [
      "Copy your Orbit link.",
      "In Claude, open Customize, then Connectors. Press + and choose Add custom connector.",
      "Paste the link and press Add, then sign in to Orbit on the page that opens.",
    ],
  },
  chatgpt: {
    label: "ChatGPT",
    settingsHref: "https://chatgpt.com/#settings",
    settingsLabel: "Open ChatGPT",
    steps: [
      "Copy your Orbit link.",
      "In ChatGPT, open Settings, then Apps. Under Advanced settings, turn on Developer mode — it needs a paid ChatGPT plan.",
      "Choose Create and paste the link, then sign in to Orbit on the page that opens.",
    ],
  },
};

const ASSISTANT_IDS = Object.keys(ASSISTANTS) as Assistant[];

/** Derived from wherever Orbit is served, so a preview deployment hands out its own link. */
const subscribeNever = () => () => {};
const getConnectorUrl = () => `${window.location.origin}/api/mcp`;

/**
 * Settings → Integrations → Claude and ChatGPT: Orbit inside the assistant someone already
 * uses. The assistant signs in to Orbit, so there is no key; the one paste left is the link
 * itself, which only an assistant's own connector directory could remove.
 */
export function AssistantsSettings() {
  const [assistant, setAssistant] = useState<Assistant>("claude");
  const [copied, setCopied] = useState(false);
  // No subscription — the origin never changes — and null on the server, which has no window.
  const url = useSyncExternalStore(subscribeNever, getConnectorUrl, () => null);
  const chosen = ASSISTANTS[assistant];

  async function copyLink() {
    if (!url) return;
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      toast.success("Link copied");
    } catch {
      toast.error(TOAST_COPY.copyFailed);
    }
  }

  return (
    <SettingsSection
      title="Claude and ChatGPT"
      description="Ask Claude or ChatGPT about your network, and let them log notes for you. They sign in to Orbit, so there's no key to copy. Works on every plan."
    >
      <div
        role="group"
        aria-label="Which assistant do you use?"
        className="inline-flex rounded-lg border border-border/70 p-0.5"
      >
        {ASSISTANT_IDS.map((id) => (
          <button
            key={id}
            type="button"
            aria-pressed={assistant === id}
            onClick={() => setAssistant(id)}
            className={cn(
              "rounded-md px-3 py-1.5 text-sm font-medium outline-none transition-colors duration-fast ease-house",
              "focus-visible:ring-2 focus-visible:ring-ring/70",
              assistant === id
                ? "bg-card text-ink shadow-sm ring-1 ring-border/70"
                : "text-muted-foreground hover:text-foreground"
            )}
          >
            I use {ASSISTANTS[id].label}
          </button>
        ))}
      </div>

      <ol className="list-decimal space-y-2 pl-5 text-sm text-foreground">
        {chosen.steps.map((step) => (
          <li key={step}>{step}</li>
        ))}
      </ol>

      <div className="flex flex-wrap items-center gap-2">
        <Button onClick={copyLink} disabled={!url}>
          {copied ? <Check aria-hidden /> : <Copy aria-hidden />}
          {copied ? "Copied" : "Copy link"}
        </Button>
        <a
          href={chosen.settingsHref}
          target="_blank"
          rel="noreferrer"
          className={buttonVariants({ variant: "outline" })}
        >
          {chosen.settingsLabel}
          <ExternalLink aria-hidden />
        </a>
      </div>

      {url ? (
        <p className="text-xs break-all text-muted-foreground">
          Your Orbit link: <span className="font-mono">{url}</span>
        </p>
      ) : null}
    </SettingsSection>
  );
}
