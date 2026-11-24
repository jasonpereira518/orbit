"use client";

import { useState } from "react";
import { Check, Copy, Mail, UserCheck } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "@/lib/toast";
import { generateIntroRequestDraft } from "@/lib/discovery/intro-draft";
import type { BrightDataCandidate } from "@/lib/brightdata";

export function IntroRequestDialog({
  open,
  onOpenChange,
  candidate,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  candidate: BrightDataCandidate | null;
}) {
  const [copied, setCopied] = useState(false);
  const [editedBody, setEditedBody] = useState<string | null>(null);

  const introPath = candidate?.introPath;
  const firstName = introPath?.introducerName.split(" ")[0] || introPath?.introducerName || "";

  const draft =
    candidate && introPath
      ? generateIntroRequestDraft({
          introducerFirstName: firstName,
          candidateFullName: candidate.fullName,
          candidateTitle: candidate.title,
          candidateCompany: candidate.company,
          relationshipContext: introPath.relationshipContext,
          projectTitle: candidate.matchedProjects?.[0]?.projectTitle,
          sharedTopic: candidate.matchedProjects?.[0]?.sharedTopics?.[0],
        })
      : { subject: "", body: "" };

  const body = editedBody ?? draft.body;

  if (!candidate || !introPath) return null;

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(`Subject: ${draft.subject}\n\n${body}`);
      setCopied(true);
      toast.success("Intro request email copied to clipboard!");
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toast.error("Couldn’t copy — select the text instead");
    }
  }

  function handleOpenMailto() {
    const mailto = `mailto:${encodeURIComponent(introPath?.email || "")}?subject=${encodeURIComponent(draft.subject)}&body=${encodeURIComponent(body)}`;
    window.open(mailto, "_blank");
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg p-6 rounded-2xl">
        <DialogHeader className="space-y-1.5">
          <div className="flex items-center gap-2">
            <span className="flex h-8 w-8 items-center justify-center rounded-full bg-success/10 text-success">
              <UserCheck className="h-4 w-4" />
            </span>
            <DialogTitle className="text-lg font-semibold text-ink">
              Request Warm Introduction
            </DialogTitle>
          </div>
          <DialogDescription className="text-xs text-muted-foreground">
            Ask your mutual connection <strong className="text-ink">{introPath.introducerName}</strong> for a warm introduction to <strong className="text-ink">{candidate.fullName}</strong>.
          </DialogDescription>
        </DialogHeader>

        {/* Introducer Context Pill */}
        <div className="rounded-xl border border-border/80 bg-muted/40 p-3 space-y-1 text-xs">
          <div className="flex items-center justify-between">
            <span className="font-medium text-ink">{introPath.introducerName}</span>
            <span className="rounded-full bg-success/10 text-success px-2 py-0.5 text-3xs font-medium">
              {introPath.introFeasibility === "high" ? "High response likelihood" : "Warm path"}
            </span>
          </div>
          <p className="text-muted-foreground text-2xs">
            {introPath.relationshipContext}
          </p>
        </div>

        {/* Draft Editor */}
        <div className="space-y-2 pt-1 text-xs">
          <div className="space-y-1">
            <span className="font-medium text-2xs text-muted-foreground uppercase tracking-wider">
              Subject
            </span>
            <div className="rounded-lg border border-border/70 bg-card px-3 py-1.5 text-xs text-ink font-medium">
              {draft.subject}
            </div>
          </div>

          <div className="space-y-1">
            <span className="font-medium text-2xs text-muted-foreground uppercase tracking-wider">
              Message Body
            </span>
            <Textarea
              value={body}
              onChange={(e) => setEditedBody(e.target.value)}
              rows={8}
              className="resize-none text-xs font-mono leading-relaxed"
            />
          </div>
        </div>

        <DialogFooter className="flex items-center justify-between gap-2 pt-2 border-t border-border/50">
          <Button
            variant="outline"
            size="sm"
            onClick={handleCopy}
            className="text-xs gap-1.5 rounded-xl"
          >
            {copied ? (
              <Check className="h-3.5 w-3.5 text-success" />
            ) : (
              <Copy className="h-3.5 w-3.5" />
            )}
            {copied ? "Copied" : "Copy to Clipboard"}
          </Button>

          <Button
            size="sm"
            onClick={handleOpenMailto}
            className="text-xs gap-1.5 rounded-xl shadow-xs"
          >
            <Mail className="h-3.5 w-3.5" />
            Open in Email Client
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
