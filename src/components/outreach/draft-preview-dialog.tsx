"use client";

import { useState, useTransition } from "react";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import {
  Briefcase,
  Check,
  Copy,
  ExternalLink,
  GraduationCap,
  Send,
  Sparkles,
  TrendingUp,
} from "lucide-react";
import { toast } from "@/lib/toast";
import { copyText } from "@/lib/clipboard";
import { markMessageAction, sendOutreachMessageAction, updateOutreachMessage } from "@/actions/outreach";
import { channelLabel } from "@/lib/outreach-channels";
import type { ProspectRow } from "@/components/outreach/prospect-table";
import { friendlyError } from "@/lib/errors";

export function DraftPreviewDialog({
  open,
  onOpenChange,
  campaignId,
  prospect,
  onUpdated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  campaignId: string;
  prospect: ProspectRow;
  onUpdated?: () => void;
}) {
  const [pending, start] = useTransition();
  const [isEditing, setIsEditing] = useState(false);
  const message = prospect.message;

  const [subject, setSubject] = useState(message?.subject || "");
  const [body, setBody] = useState(message?.body || "");

  const enrichment = (prospect.enrichment || {}) as Record<string, unknown>;
  const newsHook = (enrichment.newsContext as string) || (enrichment.recentNews as string);
  const signals = Array.isArray(enrichment.signals) ? (enrichment.signals as string[]) : [];
  const matchReason = enrichment.matchReason as string | undefined;
  const channel = message?.channel || "email";

  const hasHiringSignal = signals.some((s) => /hir|grow|scale|expan/i.test(s));

  async function handleCopy() {
    const text = channel === "email" && subject ? `Subject: ${subject}\n\n${body}` : body;
    const ok = await copyText(text);
    if (!ok) {
      toast.error("Failed to copy to clipboard");
      return;
    }
    if (message?.id) {
      start(async () => {
        try {
          await markMessageAction({ messageId: message.id, status: "copied" });
          toast.success("Draft copied to clipboard!");
          onUpdated?.();
        } catch {
          toast.success("Draft copied to clipboard!");
        }
      });
    } else {
      toast.success("Draft copied to clipboard!");
    }
  }

  async function handleSaveDraft() {
    if (!message?.id) return;
    start(async () => {
      try {
        await updateOutreachMessage({
          messageId: message.id,
          subject: channel === "email" ? subject : null,
          body,
        });
        setIsEditing(false);
        toast.success("Draft updated");
        onUpdated?.();
      } catch (err) {
        toast.error(friendlyError(err, "Couldn't save draft update"));
      }
    });
  }

  async function handleSend() {
    if (!message?.id) return;
    start(async () => {
      try {
        const res = await sendOutreachMessageAction(message.id);
        if (!res.ok) {
          toast.error(res.error);
          return;
        }
        toast.success(`Message sent to ${prospect.fullName}!`);
        onOpenChange(false);
        onUpdated?.();
      } catch (err) {
        toast.error(friendlyError(err, "Could not send message"));
      }
    });
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto rounded-3xl p-6 sm:p-7">
        <DialogHeader className="space-y-3 pb-2 border-b border-border/60">
          <div className="flex items-start justify-between gap-4">
            <div className="flex items-center gap-3">
              <div className="relative h-12 w-12 shrink-0 rounded-full overflow-hidden border border-border/60 bg-muted">
                {prospect.avatarUrl ? (
                  <img
                    src={prospect.avatarUrl}
                    alt={prospect.fullName}
                    className="h-full w-full object-cover"
                    onError={(e) => {
                      (e.target as HTMLElement).style.display = "none";
                    }}
                  />
                ) : (
                  <div className="h-full w-full flex items-center justify-center font-semibold text-sm text-muted-foreground">
                    {prospect.fullName.slice(0, 2).toUpperCase()}
                  </div>
                )}
              </div>

              <div>
                <DialogTitle className="text-xl font-[family-name:var(--font-display)] text-ink">
                  {prospect.fullName}
                </DialogTitle>
                <p className="text-xs text-muted-foreground">
                  {prospect.title || "Professional"}
                  {prospect.company ? ` at ${prospect.company}` : ""}
                  {prospect.location ? ` · ${prospect.location}` : ""}
                </p>
              </div>
            </div>

            <Badge variant="outline" className="rounded-full capitalize text-xs">
              {channelLabel(channel)}
            </Badge>
          </div>

          {/* Student-friendly Smart Badges */}
          <div className="flex flex-wrap items-center gap-1.5 pt-1">
            {typeof enrichment.effectivenessScore === "number" && (
              <span className="inline-flex items-center gap-1 rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2.5 py-0.5 text-xs font-semibold text-emerald-700 dark:text-emerald-300">
                <Sparkles className="h-3 w-3 text-emerald-500" />
                {enrichment.effectivenessScore}% Match
              </span>
            )}

            {newsHook && (
              <span className="inline-flex items-center gap-1 rounded-full border border-emerald-500/30 bg-emerald-500/5 px-2.5 py-0.5 text-xs font-medium text-emerald-700 dark:text-emerald-300">
                <TrendingUp className="h-3 w-3 text-emerald-500" />
                News Catalyst
              </span>
            )}

            {hasHiringSignal && (
              <span className="inline-flex items-center gap-1 rounded-full border border-amber-500/30 bg-amber-500/10 px-2.5 py-0.5 text-xs font-medium text-amber-700 dark:text-amber-300">
                <Briefcase className="h-3 w-3 text-amber-600" />
                Hiring Signal
              </span>
            )}

            {prospect.isDemo && (
              <Badge variant="outline" className="rounded-full text-[11px]">
                Demo Mode
              </Badge>
            )}
          </div>
        </DialogHeader>

        <div className="space-y-4 py-2">
          {/* Smart Talking Point / Why this was written */}
          {(newsHook || matchReason) && (
            <div className="rounded-2xl border border-sky-500/30 bg-sky-500/5 p-3.5 text-xs dark:bg-sky-500/10">
              <span className="font-semibold text-sky-950 dark:text-sky-100 flex items-center gap-1.5">
                <Sparkles className="h-3.5 w-3.5 text-sky-600 dark:text-sky-400" />
                Personalized Icebreaker Hook
              </span>
              <p className="mt-1 text-sky-900/90 dark:text-sky-200/90 leading-relaxed">
                {newsHook
                  ? `References: "${newsHook}". This shows you researched their current momentum before reaching out.`
                  : matchReason}
              </p>
            </div>
          )}

          {/* Subject Line (if email) */}
          {channel === "email" && (
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-muted-foreground">Subject Line</label>
              {isEditing ? (
                <Input
                  value={subject}
                  onChange={(e) => setSubject(e.target.value)}
                  placeholder="Subject line..."
                  className="rounded-xl text-sm font-medium"
                />
              ) : (
                <div className="rounded-xl border border-border/70 bg-card px-3.5 py-2.5 text-sm font-medium text-ink">
                  {subject || "(No subject)"}
                </div>
              )}
            </div>
          )}

          {/* Draft Message Body */}
          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <label className="text-xs font-medium text-muted-foreground">Draft Message</label>
              {!isEditing ? (
                <button
                  type="button"
                  onClick={() => setIsEditing(true)}
                  className="text-xs text-primary hover:underline"
                >
                  Edit message
                </button>
              ) : (
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => setIsEditing(false)}
                    className="text-xs text-muted-foreground hover:text-foreground"
                  >
                    Cancel
                  </button>
                  <Button
                    size="xs"
                    onClick={handleSaveDraft}
                    disabled={pending}
                    className="rounded-full px-2.5 py-0.5 text-xs"
                  >
                    Save Changes
                  </Button>
                </div>
              )}
            </div>

            {isEditing ? (
              <Textarea
                rows={8}
                value={body}
                onChange={(e) => setBody(e.target.value)}
                placeholder="Write your personal outreach message..."
                className="rounded-2xl font-mono text-xs leading-relaxed"
              />
            ) : (
              <div className="rounded-2xl border border-border/70 bg-card p-4 text-sm leading-relaxed whitespace-pre-wrap text-ink font-[family-name:var(--font-sans)]">
                {body || "No message draft written yet."}
              </div>
            )}
          </div>
        </div>

        <DialogFooter className="flex flex-wrap items-center justify-between gap-2.5 pt-3 border-t border-border/60">
          <div className="flex items-center gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={handleCopy}
              disabled={pending || !body}
              className="rounded-full gap-1.5 text-xs"
            >
              <Copy className="h-3.5 w-3.5" />
              Copy Text
            </Button>

            {prospect.linkedinUrl && (
              <a
                href={prospect.linkedinUrl}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-primary underline-offset-2 hover:underline"
              >
                <ExternalLink className="h-3.5 w-3.5" />
                View Profile
              </a>
            )}
          </div>

          <div className="flex items-center gap-2">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => onOpenChange(false)}
              className="rounded-full text-xs"
            >
              Close
            </Button>

            {channel === "email" && prospect.email && !prospect.isDemo && (
              <Button
                type="button"
                size="sm"
                onClick={handleSend}
                disabled={pending || !body}
                className="rounded-full gap-1.5 text-xs shadow-xs"
              >
                <Send className="h-3.5 w-3.5" />
                Send Email Now
              </Button>
            )}
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
