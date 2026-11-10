"use client";

import { useState, useSyncExternalStore } from "react";
import { Check, Copy, ExternalLink, Terminal } from "lucide-react";
import { Button, buttonVariants } from "@/components/ui/button";
import { AccountHeader, BrandStrip, FeatureRow } from "@/components/settings/account-page";
import { PROVIDER_THEMES } from "@/components/settings/provider-themes";
import { cn } from "@/lib/utils";
import { SegmentedControl } from "@/components/settings/account-rows";
import { AssistantsMark, ChatGptMark, ClaudeMark, NotionMark } from "@/components/settings/provider-marks";
import { toast } from "@/lib/toast";
import { TOAST_COPY } from "@/lib/toast-copy";

type Assistant = "claude" | "chatgpt" | "notion";

const MARKS: Record<Assistant, (props: { className?: string }) => React.ReactElement> = {
  claude: ClaudeMark,
  chatgpt: ChatGptMark,
  notion: NotionMark,
};

const ASSISTANTS: Record<
  Assistant,
  {
    label: string;
    settingsHref: string;
    settingsLabel: string;
    /** Where the link goes, in the assistant's own menu names. */
    addPath: string;
    note?: string;
  }
> = {
  claude: {
    label: "Claude",
    settingsHref: "https://claude.ai/new#customize/connectors/yours",
    settingsLabel: "Open Claude",
    addPath: "Customize → Connectors → + → Add custom connector (or Settings → Connectors)",
    note: "Works on Claude.ai with OAuth, or in Claude Desktop / Claude Code with an API key",
  },
  chatgpt: {
    label: "ChatGPT",
    settingsHref: "https://chatgpt.com/plugins",
    settingsLabel: "Open ChatGPT",
    addPath: "Settings → Apps → Advanced settings → Developer mode, then Create (or Custom GPT Action)",
    note: "Developer mode needs a paid ChatGPT plan · Custom GPTs can also use Orbit's OpenAPI schema",
  },
  notion: {
    label: "Notion AI",
    settingsHref: "https://www.notion.so/",
    settingsLabel: "Open Notion",
    addPath: "Settings → Connections → Discover → Add Custom MCP",
    note: "Needs a Notion Business or Enterprise plan, and your workspace admin must allow custom MCP",
  },
};

/** Derived from wherever Orbit is served, so a preview deployment hands out its own link. */
const subscribeNever = () => () => {};
const getConnectorUrl = () => `${window.location.origin}/api/mcp`;

/**
 * Settings → Integrations → Claude and ChatGPT: Orbit inside the assistant someone already
 * uses. The assistant signs in to Orbit, so there is no key; the one paste left is the link
 * itself, which only an assistant's own connector directory could remove.
 *
 * Wears the chosen assistant's brand the way an account page wears its provider's: the theme
 * class re-points `--primary`, so the picker, the Copy button and the focus rings all swap
 * between Claude's terracotta and ChatGPT's black as the person picks one.
 */
export function AssistantsSettings({ withNotion = false }: { withNotion?: boolean }) {
  // Notion AI ships with the Notion integration (the `feature.notion` surface).
  const assistantIds = (Object.keys(ASSISTANTS) as Assistant[]).filter((id) => id !== "notion" || withNotion);
  const [assistant, setAssistant] = useState<Assistant>("claude");
  const [copied, setCopied] = useState(false);
  // No subscription — the origin never changes — and null on the server, which has no window.
  const url = useSyncExternalStore(subscribeNever, getConnectorUrl, () => null);
  const chosen = ASSISTANTS[assistant];
  const theme = PROVIDER_THEMES[assistant];

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

  const step = (n: number) => <span className="text-xs font-semibold tabular-nums">{n}</span>;

  return (
    <div className={cn("space-y-4", theme.className)}>
      <AccountHeader
        name={withNotion ? "AI assistants" : "Claude and ChatGPT"}
        mark={<AssistantsMark />}
        accountLine={null}
        status={{ state: "on", detail: "Works on every plan · no key needed" }}
        menuItems={[]}
      />
      <div className="text-ink">
        <BrandStrip theme={theme} />
      </div>

      <SegmentedControl
        label="Which assistant do you use?"
        options={assistantIds.map((id) => {
          const Mark = MARKS[id];
          return {
            value: id,
            label: (
              <>
                <Mark className="size-4" />
                {ASSISTANTS[id].label}
              </>
            ),
          };
        })}
        value={assistant}
        onChange={(next) => {
          setAssistant(next);
          setCopied(false);
        }}
      />

      <ul>
        <FeatureRow
          icon={step(1)}
          tone={theme.tone}
          title="Copy your Orbit link"
          description={url ? <span className="font-mono text-xs break-all">{url}</span> : "Your link appears here"}
          control={{ kind: "none" }}
          onAction={() => {}}
        >
          <Button size="sm" onClick={copyLink} disabled={!url}>
            {copied ? <Check aria-hidden /> : <Copy aria-hidden />}
            {copied ? "Copied" : "Copy link"}
          </Button>
        </FeatureRow>
        <FeatureRow
          icon={step(2)}
          tone={theme.tone}
          title={`Add it in ${chosen.label}`}
          description={
            <>
              {chosen.addPath}
              {chosen.note ? <span className="block text-xs">{chosen.note}</span> : null}
            </>
          }
          control={{ kind: "none" }}
          onAction={() => {}}
        >
          <a
            href={chosen.settingsHref}
            target="_blank"
            rel="noreferrer"
            className={buttonVariants({ variant: "outline", size: "sm" })}
          >
            {chosen.settingsLabel}
            <ExternalLink aria-hidden />
          </a>
        </FeatureRow>
        <FeatureRow
          icon={step(3)}
          tone={theme.tone}
          title="Sign in to Orbit"
          description={`On the page ${chosen.label} opens · then ask about your network`}
          control={{ kind: "none" }}
          onAction={() => {}}
        />
      </ul>

      {assistant === "claude" && url ? (
        <div className="rounded-lg border border-border/60 bg-muted/30 p-4 text-xs space-y-2">
          <div className="flex items-center gap-2 font-medium text-foreground">
            <Terminal className="size-3.5 text-muted-foreground" />
            <span>Claude Desktop &amp; Claude Code</span>
          </div>
          <p className="text-muted-foreground">
            For Claude Desktop, add Orbit to your{" "}
            <code className="rounded bg-muted px-1 py-0.5 font-mono text-[11px]">claude_desktop_config.json</code> with an API key from Settings → API &amp; connectors:
          </p>
          <pre className="overflow-x-auto rounded border border-border/40 bg-background/80 p-2.5 font-mono text-[11px] text-foreground">
{JSON.stringify(
  {
    mcpServers: {
      orbit: {
        url,
        headers: {
          Authorization: "Bearer <YOUR_ORBIT_API_KEY>",
        },
      },
    },
  },
  null,
  2
)}
          </pre>
        </div>
      ) : null}

      {assistant === "chatgpt" && url ? (
        <div className="rounded-lg border border-border/60 bg-muted/30 p-4 text-xs space-y-2">
          <div className="font-medium text-foreground">Two ways to connect ChatGPT</div>
          <p className="text-muted-foreground">
            1. <strong>Developer Mode (MCP):</strong> Use your connector link above in Settings → Apps → Advanced settings → Developer mode.
          </p>
          <p className="text-muted-foreground">
            2. <strong>Custom GPT Actions:</strong> When creating a Custom GPT, import Orbit’s OpenAPI spec at{" "}
            <code className="rounded bg-muted px-1 py-0.5 font-mono text-[11px]">{url.replace("/mcp", "/v1/openapi.json")}</code> and authenticate with an Orbit API key.
          </p>
        </div>
      ) : null}
    </div>
  );
}
