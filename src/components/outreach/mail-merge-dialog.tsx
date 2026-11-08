"use client";

import { useEffect, useState, useTransition } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  AlertCircle,
  Clock,
  ExternalLink,
  Gauge,
  Inbox,
  Loader2,
  Mail,
  Send,
  Sparkles,
  UserCheck,
} from "lucide-react";
import { toast } from "@/lib/toast";
import {
  bulkSendMailMergeAction,
  getOutreachSendQuotaAction,
} from "@/actions/outreach";
import type { FiveHourQuota, OutreachSendProvider } from "@/lib/outreach-send";
import { interpolateMailMerge } from "@/lib/outreach-send";
import type { ProspectRow } from "@/components/outreach/prospect-table";

export function MailMergeDialog({
  campaignId,
  selectedProspects,
  onSent,
}: {
  campaignId: string;
  selectedProspects: ProspectRow[];
  onSent?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [pending, start] = useTransition();
  const [quotaData, setQuotaData] = useState<{
    quota: FiveHourQuota;
    providers: {
      gmail: { connected: boolean; email: string | null };
      outlook: { connected: boolean; email: string | null };
    };
  } | null>(null);

  const [provider, setProvider] = useState<OutreachSendProvider>("gmail");
  const [subjectTemplate, setSubjectTemplate] = useState("Quick note re: {{company}}");
  const [bodyTemplate, setBodyTemplate] = useState(
    "Hi {{first_name}},\n\nI noticed your recent work at {{company}} as {{title}}.\n\n{{recent_signal}}\n\nWould love to connect and share some quick thoughts on what we're building.\n\nBest,\n[Your Name]"
  );
  const [previewIndex, setPreviewIndex] = useState(0);

  useEffect(() => {
    if (open) {
      getOutreachSendQuotaAction().then((res) => {
        setQuotaData(res);
        if (res.providers.gmail.connected) {
          setProvider("gmail");
        } else if (res.providers.outlook.connected) {
          setProvider("outlook");
        } else {
          setProvider("resend");
        }
      });
    }
  }, [open]);

  const currentProspect = selectedProspects[previewIndex] || selectedProspects[0];

  const previewVariables = {
    first_name: currentProspect?.fullName ? currentProspect.fullName.split(" ")[0] : "there",
    full_name: currentProspect?.fullName || "Prospect",
    company: currentProspect?.company || "your team",
    title: currentProspect?.title || "your role",
    recent_signal: "I saw the recent product updates and team growth.",
  };

  const previewSubject = interpolateMailMerge(subjectTemplate, previewVariables);
  const previewBody = interpolateMailMerge(bodyTemplate, previewVariables);

  function insertTag(tag: string, field: "subject" | "body") {
    if (field === "subject") {
      setSubjectTemplate((prev) => `${prev} {{${tag}}}`);
    } else {
      setBodyTemplate((prev) => `${prev} {{${tag}}}`);
    }
  }

  function handleSend() {
    if (!selectedProspects.length) return;
    const messageIds = selectedProspects
      .map((p) => p.message?.id)
      .filter((id): id is string => Boolean(id));

    if (!messageIds.length) {
      toast.error("Please generate drafts for selected prospects before sending");
      return;
    }

    start(async () => {
      try {
        const res = await bulkSendMailMergeAction({
          campaignId,
          messageIds,
          provider,
          templateSubject: subjectTemplate,
          templateBody: bodyTemplate,
        });

        toast.success(`Sent ${res.sent} mail merge messages successfully!`);
        if (res.failed > 0) {
          toast.error(`${res.failed} sends failed or reached limit.`);
        }
        setOpen(false);
        onSent?.();
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Send failed");
      }
    });
  }

  const quota = quotaData?.quota;
  const sendsRequested = selectedProspects.length;
  const isOverQuota = quota ? sendsRequested > quota.remaining : false;

  return (
    <>
      <Button
        variant="default"
        size="sm"
        disabled={selectedProspects.length === 0}
        onClick={() => setOpen(true)}
        className="h-8 text-xs gap-1.5 rounded-full"
      >
        <Mail className="h-3.5 w-3.5" />
        Mass Mail Merge
        {selectedProspects.length > 0 && (
          <span className="ml-0.5 rounded-full bg-primary-foreground/20 px-1.5 py-0.5 text-[10px] font-semibold">
            {selectedProspects.length}
          </span>
        )}
      </Button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <div className="flex items-center justify-between">
              <DialogTitle className="flex items-center gap-2 text-xl font-[family-name:var(--font-display)]">
                <Send className="h-5 w-5 text-primary" />
                Mass Mail Merge Send
              </DialogTitle>
              <Badge variant="outline">{selectedProspects.length} Recipients</Badge>
            </div>
          </DialogHeader>

          <div className="space-y-5 pt-1">
            {/* 5-Hour Quota Strip */}
            {quota && (
              <div className="rounded-xl border border-border/80 bg-muted/40 p-3.5 space-y-2">
                <div className="flex items-center justify-between text-xs">
                  <span className="font-medium text-ink flex items-center gap-1.5">
                    <Gauge className="h-4 w-4 text-primary" />
                    5-Hour Rolling Send Quota
                  </span>
                  <Badge variant="outline" className="capitalize text-[10px]">
                    {quota.plan} Plan ({quota.limit} limit)
                  </Badge>
                </div>
                <div className="flex items-center justify-between text-xs text-muted-foreground">
                  <span>
                    Used: <strong className="text-ink">{quota.used}</strong> / {quota.limit}
                  </span>
                  <span className="flex items-center gap-1">
                    <Clock className="h-3 w-3" />
                    Resets at {new Date(quota.resetsAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}
                  </span>
                </div>
                <div className="h-2 w-full rounded-full bg-border overflow-hidden">
                  <div
                    className={`h-full transition-all ${
                      quota.remaining === 0 ? "bg-red-500" : quota.remaining < 10 ? "bg-amber-500" : "bg-emerald-500"
                    }`}
                    style={{ width: `${Math.min(100, (quota.used / quota.limit) * 100)}%` }}
                  />
                </div>
                {isOverQuota && (
                  <p className="text-[11px] text-amber-600 dark:text-amber-400 flex items-center gap-1 pt-0.5">
                    <AlertCircle className="h-3.5 w-3.5 shrink-0" />
                    You selected {sendsRequested} prospects, but have {quota.remaining} sends remaining in this 5-hour window.
                  </p>
                )}
              </div>
            )}

            {/* Account Selector */}
            <div className="space-y-2">
              <Label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                Send From Account
              </Label>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                <button
                  type="button"
                  onClick={() => setProvider("gmail")}
                  className={`flex flex-col items-start p-3 rounded-xl border text-left text-xs transition ${
                    provider === "gmail"
                      ? "border-primary bg-primary/5 text-ink ring-1 ring-primary"
                      : "border-border/70 hover:border-primary/40 text-muted-foreground"
                  }`}
                >
                  <div className="flex items-center justify-between w-full">
                    <span className="font-semibold text-ink flex items-center gap-1.5">
                      <Inbox className="h-3.5 w-3.5 text-red-500" /> Gmail
                    </span>
                    {quotaData?.providers.gmail.connected && (
                      <span className="h-2 w-2 rounded-full bg-emerald-500" />
                    )}
                  </div>
                  <span className="mt-1 text-[11px] truncate w-full">
                    {quotaData?.providers.gmail.email || "Not connected"}
                  </span>
                </button>

                <button
                  type="button"
                  onClick={() => setProvider("outlook")}
                  className={`flex flex-col items-start p-3 rounded-xl border text-left text-xs transition ${
                    provider === "outlook"
                      ? "border-primary bg-primary/5 text-ink ring-1 ring-primary"
                      : "border-border/70 hover:border-primary/40 text-muted-foreground"
                  }`}
                >
                  <div className="flex items-center justify-between w-full">
                    <span className="font-semibold text-ink flex items-center gap-1.5">
                      <Inbox className="h-3.5 w-3.5 text-blue-500" /> Outlook
                    </span>
                    {quotaData?.providers.outlook.connected && (
                      <span className="h-2 w-2 rounded-full bg-emerald-500" />
                    )}
                  </div>
                  <span className="mt-1 text-[11px] truncate w-full">
                    {quotaData?.providers.outlook.email || "Not connected"}
                  </span>
                </button>

                <button
                  type="button"
                  onClick={() => setProvider("resend")}
                  className={`flex flex-col items-start p-3 rounded-xl border text-left text-xs transition ${
                    provider === "resend"
                      ? "border-primary bg-primary/5 text-ink ring-1 ring-primary"
                      : "border-border/70 hover:border-primary/40 text-muted-foreground"
                  }`}
                >
                  <div className="flex items-center justify-between w-full">
                    <span className="font-semibold text-ink flex items-center gap-1.5">
                      <Mail className="h-3.5 w-3.5 text-primary" /> Orbit Resend
                    </span>
                  </div>
                  <span className="mt-1 text-[11px]">System / Custom SMTP</span>
                </button>
              </div>
            </div>

            {/* Template Variables Pills */}
            <div className="space-y-1.5">
              <Label className="text-xs text-muted-foreground">Insert Mail Merge Variable:</Label>
              <div className="flex flex-wrap gap-1.5">
                {[
                  { tag: "first_name", label: "First Name" },
                  { tag: "company", label: "Company" },
                  { tag: "title", label: "Job Title" },
                  { tag: "recent_signal", label: "Recent News / Signal" },
                ].map(({ tag, label }) => (
                  <button
                    key={tag}
                    type="button"
                    onClick={() => insertTag(tag, "body")}
                    className="inline-flex items-center gap-1 rounded-md border border-border/80 bg-muted/50 px-2 py-0.5 text-xs text-ink hover:bg-muted"
                  >
                    <Sparkles className="h-2.5 w-2.5 text-primary" />
                    {label} <code className="text-[10px] text-muted-foreground">{"{{" + tag + "}}"}</code>
                  </button>
                ))}
              </div>
            </div>

            {/* Subject & Body */}
            <div className="space-y-3">
              <div>
                <Label htmlFor="mm-subject" className="text-xs">Subject</Label>
                <Input
                  id="mm-subject"
                  value={subjectTemplate}
                  onChange={(e) => setSubjectTemplate(e.target.value)}
                  className="mt-1 text-sm"
                />
              </div>

              <div>
                <Label htmlFor="mm-body" className="text-xs">Message Template</Label>
                <Textarea
                  id="mm-body"
                  rows={5}
                  value={bodyTemplate}
                  onChange={(e) => setBodyTemplate(e.target.value)}
                  className="mt-1 font-mono text-xs leading-relaxed"
                />
              </div>
            </div>

            {/* Live Recipient Preview */}
            <div className="rounded-xl border border-border/70 bg-card p-3.5 space-y-2">
              <div className="flex items-center justify-between text-xs">
                <span className="font-medium text-ink flex items-center gap-1.5">
                  <UserCheck className="h-3.5 w-3.5 text-primary" />
                  Live Recipient Preview ({previewIndex + 1} of {selectedProspects.length})
                </span>
                <div className="flex gap-1">
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-6 px-2 text-xs"
                    disabled={previewIndex <= 0}
                    onClick={() => setPreviewIndex((i) => i - 1)}
                  >
                    Previous
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-6 px-2 text-xs"
                    disabled={previewIndex >= selectedProspects.length - 1}
                    onClick={() => setPreviewIndex((i) => i + 1)}
                  >
                    Next
                  </Button>
                </div>
              </div>
              <div className="rounded-lg bg-muted/40 p-2.5 text-xs space-y-1">
                <div>
                  <span className="text-muted-foreground">To:</span>{" "}
                  <strong className="text-ink">{currentProspect?.fullName}</strong> ({currentProspect?.email || "email@example.com"})
                </div>
                <div>
                  <span className="text-muted-foreground">Subject:</span>{" "}
                  <span className="text-ink font-medium">{previewSubject}</span>
                </div>
                <div className="pt-1.5 border-t border-border/40 whitespace-pre-wrap text-muted-foreground leading-relaxed">
                  {previewBody}
                </div>
              </div>
            </div>

            {/* Actions */}
            <div className="flex justify-end gap-2 pt-2 border-t border-border/70">
              <Button variant="outline" size="sm" onClick={() => setOpen(false)}>
                Cancel
              </Button>
              <Button
                size="sm"
                disabled={pending || quota?.remaining === 0}
                onClick={handleSend}
                className="bg-primary text-primary-foreground hover:bg-primary/90 gap-1.5"
              >
                {pending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
                Send {Math.min(sendsRequested, quota?.remaining ?? sendsRequested)} Emails
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
