"use client";

import { useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Check, Copy, ExternalLink, Globe, ShieldCheck, Sparkles, Terminal } from "lucide-react";
import { toast } from "@/lib/toast";
import { copyText } from "@/lib/clipboard";

export function BrightDataIntegrationGuide({
  isConfigured,
  zoneName = "web_unlocker1",
}: {
  isConfigured: boolean;
  zoneName?: string;
}) {
  const [open, setOpen] = useState(false);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);

  const envSnippet = `# BrightData API Credentials
BRIGHTDATA_API_KEY=your_brightdata_api_token_here
BRIGHTDATA_ZONE=${zoneName}
BRIGHTDATA_CUSTOMER_ID=hl_your_customer_id # Optional for proxy-based routes`;

  async function handleCopy(text: string, id: string) {
    const ok = await copyText(text);
    if (ok) {
      setCopiedKey(id);
      toast.success("Copied to clipboard");
      setTimeout(() => setCopiedKey(null), 2000);
    }
  }

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="inline-flex items-center gap-1.5 rounded-lg border border-border/70 bg-card px-2.5 py-1 text-xs text-muted-foreground transition hover:border-border hover:text-ink shadow-xs"
      >
        <Globe className="h-3.5 w-3.5 text-primary" />
        <span>Scraper:</span>
        {isConfigured ? (
          <span className="inline-flex items-center gap-1 font-medium text-emerald-600 dark:text-emerald-400">
            <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
            Live
          </span>
        ) : (
          <span className="inline-flex items-center gap-1 text-amber-600 dark:text-amber-400">
            <span className="h-1.5 w-1.5 rounded-full bg-amber-500" />
            Preview
          </span>
        )}
      </button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-2xl sm:max-h-[85dvh] overflow-y-auto">
        <DialogHeader>
          <div className="flex items-center justify-between">
            <DialogTitle className="flex items-center gap-2 text-xl font-[family-name:var(--font-display)]">
              <Sparkles className="h-5 w-5 text-primary" />
              BrightData Web Scraping Integration
            </DialogTitle>
            {isConfigured ? (
              <Badge className="bg-emerald-500/10 text-emerald-600 border-emerald-500/30">Active</Badge>
            ) : (
              <Badge className="bg-amber-500/10 text-amber-600 border-amber-500/30">Preview Mode</Badge>
            )}
          </div>
        </DialogHeader>

        <div className="space-y-5 text-sm text-muted-foreground pt-2">
          <p>
            Orbit uses <strong className="text-ink">BrightData</strong> to scrape LinkedIn profiles, extract high-resolution avatars, and discover company news triggers with anti-bot protection and automated rate caching.
          </p>

          <div className="rounded-xl border border-primary/20 bg-primary/5 p-4 space-y-2">
            <h4 className="font-semibold text-ink flex items-center gap-2">
              <ShieldCheck className="h-4 w-4 text-primary" />
              Lookup Efficiency Architecture
            </h4>
            <p className="text-xs leading-relaxed">
              Every search and scrape result is cached in Orbit for <strong>14 days</strong>. Repeated lookups or browsing existing candidates cost zero BrightData credits. Fast SERP previews are fetched first, and deep profile parsing is performed only on demand.
            </p>
          </div>

          <div className="space-y-3">
            <h4 className="font-semibold text-ink">Exact Step-by-Step Setup:</h4>
            <ol className="space-y-3 list-decimal list-inside text-xs leading-relaxed">
              <li className="pl-1">
                <span className="font-medium text-ink">Sign up or Log In to BrightData:</span>
                <div className="mt-1 pl-4">
                  Visit{" "}
                  <a
                    href="https://brightdata.com"
                    target="_blank"
                    rel="noreferrer"
                    className="text-primary underline underline-offset-2 inline-flex items-center gap-1"
                  >
                    brightdata.com <ExternalLink className="h-3 w-3" />
                  </a>{" "}
                  and create an account.
                </div>
              </li>
              <li className="pl-1">
                <span className="font-medium text-ink">Create a Web Unlocker or SERP Zone:</span>
                <div className="mt-1 pl-4">
                  In your BrightData Dashboard, navigate to <strong>Proxies & Scraping Infrastructure</strong> → click <strong>Add</strong> → select <strong>Web Unlocker</strong> (or <strong>SERP API</strong>). Name the zone (e.g. <code className="rounded bg-muted px-1 py-0.5 font-mono">web_unlocker1</code>).
                </div>
              </li>
              <li className="pl-1">
                <span className="font-medium text-ink">Obtain your API Key:</span>
                <div className="mt-1 pl-4">
                  Navigate to <strong>Account Settings</strong> → <strong>API Keys</strong> → click <strong>Add Key</strong>. Copy your generated token.
                </div>
              </li>
              <li className="pl-1">
                <span className="font-medium text-ink">Add to your Environment File:</span>
                <div className="mt-1 pl-4">
                  Add the keys to your project root <code className="rounded bg-muted px-1 py-0.5 font-mono">.env.local</code> file:
                </div>
              </li>
            </ol>
          </div>

          <div className="relative rounded-xl border border-border/80 bg-muted/40 p-3 font-mono text-xs">
            <div className="flex items-center justify-between pb-2 text-muted-foreground border-b border-border/50">
              <span className="flex items-center gap-1.5">
                <Terminal className="h-3.5 w-3.5" /> .env.local
              </span>
              <Button
                variant="ghost"
                size="sm"
                className="h-7 px-2 text-xs"
                onClick={() => handleCopy(envSnippet, "env")}
              >
                {copiedKey === "env" ? <Check className="h-3.5 w-3.5 text-emerald-500" /> : <Copy className="h-3.5 w-3.5" />}
                <span className="ml-1">Copy</span>
              </Button>
            </div>
            <pre className="pt-2 overflow-x-auto text-ink">{envSnippet}</pre>
          </div>

          <div className="flex justify-end gap-2 pt-2">
            <Button variant="outline" onClick={() => setOpen(false)}>
              Got it
            </Button>
            <Button
              className="bg-primary text-primary-foreground hover:bg-primary/90"
              onClick={() => {
                window.open("https://brightdata.com/cp", "_blank");
              }}
            >
              Open BrightData Dashboard
              <ExternalLink className="ml-1.5 h-3.5 w-3.5" />
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
    </>
  );
}
