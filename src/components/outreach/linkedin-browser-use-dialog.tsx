"use client";

import { useState, useTransition } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { AlertCircle, Bot, Check, Copy, Download, ExternalLink, Loader2, Play, ShieldAlert, Sparkles } from "lucide-react";
import { toast } from "@/lib/toast";
import { copyText } from "@/lib/clipboard";
import { generateLinkedInBrowserUsePromptAction } from "@/actions/outreach";
import type { BrowserUseTaskConfig } from "@/lib/browser-use";

export function LinkedInBrowserUseDialog({
  campaignId,
  selectedProspectIds,
  disabled,
}: {
  campaignId: string;
  selectedProspectIds: string[];
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [pending, start] = useTransition();
  const [taskConfig, setTaskConfig] = useState<BrowserUseTaskConfig | null>(null);
  const [executing, setExecuting] = useState(false);
  const [progressIndex, setProgressIndex] = useState(0);
  const [copied, setCopied] = useState(false);

  async function handleOpen() {
    if (!selectedProspectIds.length) {
      toast.error("Select at least one prospect to connect on LinkedIn");
      return;
    }
    setOpen(true);
    start(async () => {
      try {
        const config = await generateLinkedInBrowserUsePromptAction({
          campaignId,
          prospectIds: selectedProspectIds,
        });
        setTaskConfig(config);
      } catch (err) {
        toast.error("Failed to generate LinkedIn Browser Use prompt");
        setOpen(false);
      }
    });
  }

  async function handleCopyPrompt() {
    if (!taskConfig) return;
    const ok = await copyText(taskConfig.promptMarkdown);
    if (ok) {
      setCopied(true);
      toast.success("OpenAI Browser Use prompt copied to clipboard!");
      setTimeout(() => setCopied(false), 2500);
    }
  }

  function handleDownloadJson() {
    if (!taskConfig) return;
    const blob = new Blob([JSON.stringify(taskConfig, null, 2)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `browser-use-linkedin-task-${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(url);
    toast.success("Downloaded browser-use task JSON");
  }

  function handleSimulateRun() {
    if (!taskConfig || !taskConfig.targets.length) return;
    setExecuting(true);
    setProgressIndex(0);

    const interval = setInterval(() => {
      setProgressIndex((prev) => {
        if (prev + 1 >= taskConfig.targets.length) {
          clearInterval(interval);
          setExecuting(false);
          toast.success("Browser Use sequence simulation complete! All targets queued.");
          return prev + 1;
        }
        return prev + 1;
      });
    }, 2000);
  }

  return (
    <>
      <Button
        variant="outline"
        size="sm"
        disabled={disabled || selectedProspectIds.length === 0}
        onClick={handleOpen}
        className="h-8 text-xs gap-1.5 border-primary/40 bg-primary/5 hover:bg-primary/10 text-ink font-medium"
      >
        <Bot className="h-3.5 w-3.5 text-primary" />
        LinkedIn Connect
        {selectedProspectIds.length > 0 && (
          <span className="ml-0.5 rounded-full bg-primary/10 px-1.5 py-0.5 text-[10px] font-semibold text-primary">
            {selectedProspectIds.length}
          </span>
        )}
      </Button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <div className="flex items-center justify-between">
              <DialogTitle className="flex items-center gap-2 text-xl font-[family-name:var(--font-display)]">
                <Bot className="h-5 w-5 text-primary" />
                LinkedIn Outreach via OpenAI Browser Use
              </DialogTitle>
              <Badge variant="outline" className="text-xs">
                {selectedProspectIds.length} {selectedProspectIds.length === 1 ? "Target" : "Targets"}
              </Badge>
            </div>
          </DialogHeader>

          {pending || !taskConfig ? (
            <div className="py-12 flex flex-col items-center justify-center gap-3 text-muted-foreground">
              <Loader2 className="h-6 w-6 animate-spin text-primary" />
              <p className="text-sm">Preparing prefilled OpenAI Browser Use prompt & personalized notes...</p>
            </div>
          ) : (
            <div className="space-y-5 pt-2">
              <div className="rounded-xl border border-border/80 bg-muted/30 p-4 space-y-2 text-xs text-muted-foreground">
                <div className="flex items-center gap-2 font-medium text-ink text-sm">
                  <ShieldAlert className="h-4 w-4 text-amber-500" />
                  Automated Human-Like Pacing & 300-Char Safety Guardrails
                </div>
                <p>
                  This prefilled prompt instructs OpenAI's Browser Use agent to visit each LinkedIn profile, verify they aren't already connected, insert their custom personalized note, and space actions by 6-12 seconds to respect LinkedIn's weekly invitation quota.
                </p>
              </div>

              {/* Target Preview */}
              <div className="space-y-2">
                <div className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                  Prospects & Personalized Notes Queue
                </div>
                <div className="max-h-48 overflow-y-auto space-y-2 rounded-xl border border-border/70 p-3 bg-card">
                  {taskConfig.targets.map((target, idx) => (
                    <div
                      key={target.prospectId}
                      className={`rounded-lg border p-2.5 text-xs transition ${
                        executing && idx === progressIndex
                          ? "border-primary bg-primary/5"
                          : executing && idx < progressIndex
                            ? "border-emerald-500/30 bg-emerald-500/5 opacity-80"
                            : "border-border/50 bg-background"
                      }`}
                    >
                      <div className="flex items-center justify-between">
                        <span className="font-medium text-ink">
                          {idx + 1}. {target.fullName} — <span className="text-muted-foreground">{target.title} at {target.company}</span>
                        </span>
                        <div className="flex items-center gap-2">
                          <span className="text-[10px] text-muted-foreground">
                            {target.personalizedNote.length}/300 chars
                          </span>
                          {executing && idx === progressIndex && (
                            <Badge className="bg-primary/20 text-primary border-primary/30 text-[10px] animate-pulse">
                              Connecting...
                            </Badge>
                          )}
                          {executing && idx < progressIndex && (
                            <Badge className="bg-emerald-500/20 text-emerald-600 border-emerald-500/30 text-[10px]">
                              Done
                            </Badge>
                          )}
                        </div>
                      </div>
                      <p className="mt-1 text-muted-foreground italic line-clamp-2">
                        &quot;{target.personalizedNote}&quot;
                      </p>
                    </div>
                  ))}
                </div>
              </div>

              {/* Prefilled Prompt Code Block */}
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <div className="text-xs font-semibold uppercase tracking-wider text-muted-foreground flex items-center gap-1.5">
                    <Sparkles className="h-3.5 w-3.5 text-primary" />
                    Prefilled OpenAI Browser Use Prompt
                  </div>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-7 text-xs gap-1.5"
                    onClick={handleCopyPrompt}
                  >
                    {copied ? <Check className="h-3.5 w-3.5 text-emerald-500" /> : <Copy className="h-3.5 w-3.5" />}
                    {copied ? "Copied!" : "Copy Prompt"}
                  </Button>
                </div>

                <div className="relative rounded-xl border border-border/80 bg-muted/40 p-3 font-mono text-xs max-h-48 overflow-y-auto">
                  <pre className="text-ink whitespace-pre-wrap">{taskConfig.promptMarkdown}</pre>
                </div>
              </div>

              {/* Action Buttons */}
              <div className="flex flex-wrap items-center justify-between gap-3 pt-3 border-t border-border/70">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleDownloadJson}
                  className="text-xs gap-1.5"
                >
                  <Download className="h-3.5 w-3.5" />
                  Download JSON Task
                </Button>

                <div className="flex items-center gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setOpen(false)}
                  >
                    Close
                  </Button>
                  <Button
                    size="sm"
                    onClick={handleCopyPrompt}
                    className="bg-primary text-primary-foreground hover:bg-primary/90 gap-1.5"
                  >
                    <Copy className="h-3.5 w-3.5" />
                    Copy & Run in OpenAI Browser Use
                  </Button>
                </div>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
