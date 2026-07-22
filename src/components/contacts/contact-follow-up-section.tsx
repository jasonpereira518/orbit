"use client";

import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Calendar, Mail, MessageSquare, RefreshCw } from "lucide-react";
import type { ReactNode } from "react";

function LinkedInGlyph({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden
      className={className}
    >
      <path d="M20.447 20.452h-3.554v-5.569c0-1.328-.027-3.037-1.852-3.037-1.853 0-2.136 1.445-2.136 2.939v5.667H9.351V9h3.414v1.561h.046c.477-.9 1.637-1.85 3.37-1.85 3.601 0 4.267 2.37 4.267 5.455v6.286zM5.337 7.433a2.062 2.062 0 01-2.063-2.065 2.064 2.064 0 112.063 2.065zm1.782 13.019H3.555V9h3.564v11.452zM22.225 0H1.771C.792 0 0 .774 0 1.729v20.542C0 23.227.792 24 1.771 24h20.451C23.2 24 24 23.227 24 22.271V1.729C24 .774 23.2 0 22.222 0h.003z" />
    </svg>
  );
}
import { toast } from "@/lib/toast";
import {
  draftContactFollowUp,
  sendContactFollowUpEmail,
  type ContactFollowUpSendOptions,
} from "@/actions/contacts";
import {
  clearContactFollowUp,
  completeFollowUpWithTouch,
  scheduleContactFollowUp,
  scheduleContactFollowUpAt,
} from "@/actions/reminders";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import { buildLinkedInUrl } from "@/lib/outreach-channels";
import { promptNotificationsAfterFollowUpAction } from "@/lib/browser-notifications";
import { cn } from "@/lib/utils";

type Platform = "email" | "linkedin" | "sms";

const REMIND_PRESETS = [
  { days: 1, label: "1d" },
  { days: 3, label: "3d" },
  { days: 7, label: "7d" },
] as const;

function smsHref(phone: string, body: string) {
  const digits = phone.replace(/[^\d+]/g, "");
  const encoded = encodeURIComponent(body);
  return `sms:${digits}${encoded ? `?&body=${encoded}` : ""}`;
}

export function ContactFollowUpSection({
  contactId,
  contactName,
  nextFollowUpAt,
  sendOptions,
  phone,
  initialIntent,
}: {
  contactId: string;
  contactName: string;
  nextFollowUpAt?: string | Date | null;
  sendOptions: ContactFollowUpSendOptions;
  phone?: string | null;
  /** Prefill intent for intro/reach-out drafts (e.g. related person). */
  initialIntent?: string | null;
}) {
  const router = useRouter();
  const dateRef = useRef<HTMLInputElement>(null);
  const [platform, setPlatform] = useState<Platform | null>(null);
  const [draft, setDraft] = useState("");
  const [intent, setIntent] = useState(initialIntent?.trim() || "");
  const [pending, start] = useTransition();
  const [sending, startSend] = useTransition();
  const [marking, startMark] = useTransition();
  const [scheduling, startSchedule] = useTransition();

  const dueLabel = nextFollowUpAt
    ? (() => {
        try {
          return new Date(nextFollowUpAt).toLocaleDateString(undefined, {
            month: "short",
            day: "numeric",
          });
        } catch {
          return null;
        }
      })()
    : null;

  function scheduleDays(days: number) {
    startSchedule(async () => {
      try {
        await scheduleContactFollowUp(contactId, days);
        const permission = await promptNotificationsAfterFollowUpAction();
        toast.success(
          permission === "granted"
            ? `Reminder in ${days} day${days === 1 ? "" : "s"} — alerts on`
            : `Reminder set for ${days} day${days === 1 ? "" : "s"}`
        );
        router.refresh();
      } catch (err) {
        toast.error(
          err instanceof Error ? err.message : "Could not set reminder"
        );
      }
    });
  }

  function scheduleDate(value: string) {
    if (!value) return;
    startSchedule(async () => {
      try {
        await scheduleContactFollowUpAt(contactId, value);
        await promptNotificationsAfterFollowUpAction();
        toast.success("Reminder scheduled");
        router.refresh();
      } catch (err) {
        toast.error(
          err instanceof Error ? err.message : "Could not set reminder"
        );
      }
    });
  }

  function draftFor(p: Platform) {
    setPlatform(p);
    start(async () => {
      try {
        const result = await draftContactFollowUp(contactId, {
          channel: p,
          intent: intent.trim() || undefined,
        });
        setDraft(result.body);
        toast.success("Draft ready");
      } catch (err) {
        toast.error(
          err instanceof Error ? err.message : "Could not draft follow-up"
        );
      }
    });
  }

  function openNative() {
    if (!draft.trim() || !platform) return;
    if (platform === "email" && sendOptions.email) {
      const subject = encodeURIComponent(`Following up · ${contactName}`);
      const body = encodeURIComponent(draft);
      window.open(
        `mailto:${sendOptions.email}?subject=${subject}&body=${body}`,
        "_blank"
      );
      return;
    }
    if (platform === "linkedin" && sendOptions.linkedinUrl) {
      void navigator.clipboard.writeText(draft);
      toast.success("Copied — paste into LinkedIn");
      window.open(
        buildLinkedInUrl(sendOptions.linkedinUrl),
        "_blank",
        "noopener,noreferrer"
      );
      return;
    }
    if (platform === "sms" && phone) {
      window.location.href = smsHref(phone, draft);
      return;
    }
    toast.error("Missing contact details for that channel");
  }

  function sendEmail() {
    if (!draft.trim()) return;
    startSend(async () => {
      try {
        await sendContactFollowUpEmail(contactId, draft);
        toast.success(`Email sent to ${contactName}`);
        router.refresh();
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Could not send email");
      }
    });
  }

  function markSent() {
    const channel =
      platform === "email"
        ? "email"
        : platform === "linkedin"
          ? "linkedin_message"
          : "note";
    startMark(async () => {
      try {
        await completeFollowUpWithTouch(contactId, {
          channel,
          notes: draft.trim() || undefined,
        });
        toast.success("Follow-up marked sent");
        router.refresh();
      } catch (err) {
        toast.error(
          err instanceof Error ? err.message : "Could not mark follow-up sent"
        );
      }
    });
  }

  const platforms: Array<{
    id: Platform;
    label: string;
    icon: ReactNode;
    available: boolean;
  }> = [
    {
      id: "email",
      label: "Email",
      icon: <Mail className="size-3.5" />,
      available: sendOptions.hasEmail,
    },
    {
      id: "linkedin",
      label: "LinkedIn",
      icon: <LinkedInGlyph className="size-3.5" />,
      available: sendOptions.hasLinkedIn,
    },
    {
      id: "sms",
      label: "Text",
      icon: <MessageSquare className="size-3.5" />,
      available: Boolean(phone?.trim()),
    },
  ];

  return (
    <Card id="follow-up" className="scroll-mt-24 border-border/70 shadow-none">
      <CardHeader>
        <CardTitle>Follow up</CardTitle>
        <p className="text-sm text-muted-foreground">
          Schedule a reminder, or pick a channel to draft a message from your
          history.
        </p>
      </CardHeader>
      <CardContent>
      <div className="space-y-4">
        <div>
          <div className="mb-2 flex flex-wrap items-center gap-2">
            <p className="text-xs font-medium text-muted-foreground">Remind</p>
            {dueLabel ? (
              <p className="text-xs text-muted-foreground">Due {dueLabel}</p>
            ) : null}
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            {REMIND_PRESETS.map((p) => (
              <Button
                key={p.days}
                type="button"
                size="sm"
                variant="outline"
                disabled={scheduling}
                className="h-8 px-2.5"
                onClick={() => scheduleDays(p.days)}
              >
                {p.label}
              </Button>
            ))}
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={scheduling}
              className="h-8 gap-1.5 px-2.5"
              onClick={() => dateRef.current?.showPicker?.() ?? dateRef.current?.click()}
            >
              <Calendar className="size-3.5" />
              Calendar
            </Button>
            <input
              ref={dateRef}
              type="date"
              className="sr-only"
              onChange={(e) => {
                if (e.target.value) scheduleDate(e.target.value);
              }}
            />
            {nextFollowUpAt ? (
              <Button
                type="button"
                size="sm"
                variant="ghost"
                disabled={scheduling}
                className="h-8 px-2.5 text-muted-foreground"
                onClick={() =>
                  startSchedule(async () => {
                    await clearContactFollowUp(contactId);
                    toast.success("Reminder cleared");
                    router.refresh();
                  })
                }
              >
                Clear
              </Button>
            ) : null}
          </div>
        </div>

        <div>
          <p className="mb-2 text-xs font-medium text-muted-foreground">
            Draft for
          </p>
          {initialIntent || intent ? (
            <input
              type="text"
              value={intent}
              onChange={(e) => setIntent(e.target.value)}
              placeholder="Optional intent (e.g. ask for intro)"
              className="mb-2 w-full max-w-md rounded-lg border border-border/70 bg-transparent px-3 py-1.5 text-sm outline-none focus:border-border"
            />
          ) : null}
          <div className="flex flex-wrap gap-1.5">
            {platforms.map((p) => (
              <Button
                key={p.id}
                type="button"
                size="sm"
                variant={platform === p.id ? "default" : "outline"}
                disabled={pending || !p.available}
                className={cn("h-8 gap-1.5", !p.available && "opacity-40")}
                title={
                  p.available
                    ? `Draft ${p.label} follow-up`
                    : `Add ${p.label} on this contact first`
                }
                onClick={() => draftFor(p.id)}
              >
                {p.icon}
                {p.label}
              </Button>
            ))}
            {draft ? (
              <Button
                type="button"
                size="sm"
                variant="ghost"
                disabled={pending || !platform}
                className="h-8 gap-1.5"
                onClick={() => platform && draftFor(platform)}
              >
                <RefreshCw
                  className={`size-3.5 ${pending ? "animate-spin" : ""}`}
                />
                Regenerate
              </Button>
            ) : null}
          </div>
        </div>

        {pending && !draft ? (
          <p className="text-sm text-muted-foreground">Drafting…</p>
        ) : null}

        {draft ? (
          <div className="space-y-3">
            <Textarea
              rows={7}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              className="resize-y text-sm"
            />
            <div className="flex flex-wrap gap-2">
              <Button type="button" size="sm" variant="outline" onClick={openNative}>
                Open {platform === "sms" ? "Messages" : platform === "linkedin" ? "LinkedIn" : "Mail"}
              </Button>
              {platform === "email" && sendOptions.canSendEmail ? (
                <Button
                  type="button"
                  size="sm"
                  disabled={sending || marking}
                  onClick={sendEmail}
                >
                  {sending ? "Sending…" : "Send email"}
                </Button>
              ) : null}
              <Button
                type="button"
                size="sm"
                variant="ghost"
                disabled={marking}
                onClick={markSent}
              >
                {marking ? "Saving…" : "Mark sent"}
              </Button>
            </div>
          </div>
        ) : null}
      </div>
      </CardContent>
    </Card>
  );
}
