"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Mail, MessageSquare, RefreshCw } from "lucide-react";
import type { ReactNode } from "react";
import { LinkedInGlyph } from "@/components/contacts/contact-profile-icons";
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
  setKeepInTouchCadence,
} from "@/actions/reminders";
import { showUndoSendToast } from "@/components/email/undo-send-toast";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { DatePickerButton, toLocalYmd } from "@/components/ui/date-picker";
import { Textarea } from "@/components/ui/textarea";
import { KEEP_IN_TOUCH_PRESETS } from "@/lib/keep-in-touch";
import { buildLinkedInUrl } from "@/lib/outreach-channels";
import { promptNotificationsAfterFollowUpAction } from "@/lib/browser-notifications";
import { cn } from "@/lib/utils";
import { AiKeyNotice } from "@/components/ai-key-notice";
import { aiDenialFromMessage } from "@/lib/ai-access-copy";
import { friendlyError } from "@/lib/errors";
import { TOAST_COPY } from "@/lib/toast-copy";

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

function dueYmd(value: string | Date | null | undefined): string | null {
  if (!value) return null;
  try {
    return toLocalYmd(new Date(value));
  } catch {
    return null;
  }
}

export function ContactFollowUpSection({
  contactId,
  contactName,
  nextFollowUpAt,
  keepInTouchDays,
  sendOptions,
  phone,
  initialIntent,
  bare = false,
}: {
  contactId: string;
  contactName: string;
  nextFollowUpAt?: string | Date | null;
  /** The interval the user set for this contact, or null if they never did. */
  keepInTouchDays?: number | null;
  sendOptions: ContactFollowUpSendOptions;
  phone?: string | null;
  /** Prefill intent for intro/reach-out drafts (e.g. related person). */
  initialIntent?: string | null;
  /** Skip the outer Card chrome and "Follow up" header — for use inside a
   * container (e.g. a Sheet) that already provides its own framing/title. */
  bare?: boolean;
}) {
  const router = useRouter();
  const [platform, setPlatform] = useState<Platform | null>(null);
  const [draft, setDraft] = useState("");
  const [aiError, setAiError] = useState<string | null>(null);
  const [intent, setIntent] = useState(initialIntent?.trim() || "");
  const [pending, start] = useTransition();
  const [sending, startSend] = useTransition();
  const [marking, startMark] = useTransition();
  const [scheduling, startSchedule] = useTransition();
  const [cadencePending, startCadence] = useTransition();
  // Optimistic, because the whole control is four buttons and a round-trip through
  // `router.refresh()` is long enough to make a click feel dropped. Reset from the prop on
  // failure so a rejected write cannot leave the UI claiming a cadence that was not saved.
  const [cadence, setCadence] = useState<number | null>(keepInTouchDays ?? null);

  const scheduledYmd = dueYmd(nextFollowUpAt);
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
            ? `Follow-up set for ${days} ${days === 1 ? "day" : "days"} from now — desktop alerts are on`
            : `Follow-up set for ${days} ${days === 1 ? "day" : "days"} from now`
        );
        router.refresh();
      } catch (err) {
        toast.error(
          friendlyError(err, "Couldn’t set that reminder — try again?")
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
        toast.success(TOAST_COPY.reminderSet);
        router.refresh();
      } catch (err) {
        toast.error(
          friendlyError(err, "Couldn’t set that reminder — try again?")
        );
      }
    });
  }

  function saveCadence(days: number | null) {
    const previous = cadence;
    setCadence(days);
    startCadence(async () => {
      try {
        const result = await setKeepInTouchCadence(contactId, days);
        setCadence(result.keepInTouchDays);
        toast.success(
          result.keepInTouchDays
            ? `Keeping in touch — every ${result.keepInTouchDays} days`
            : "Cadence cleared"
        );
        router.refresh();
      } catch (err) {
        setCadence(previous);
        toast.error(friendlyError(err, "Couldn’t save that cadence — try again?"));
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
        if (!result.ok) {
          setAiError(result.error);
          return;
        }
        setAiError(null);
        setDraft(result.body);
        toast.success("Draft ready");
      } catch (err) {
        toast.error(
          friendlyError(err, TOAST_COPY.draftFollowUpFailed)
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
      toast.success("Copied — paste it into LinkedIn");
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
    toast.error("This contact has no details for that channel yet");
  }

  function sendEmail() {
    if (!draft.trim()) return;
    startSend(async () => {
      try {
        const res = await sendContactFollowUpEmail(contactId, draft);
        if (!res.ok) {
          toast.error(res.message);
          return;
        }
        showUndoSendToast({ sendId: res.sendId, recipientLabel: contactName, onUndone: () => router.refresh() });
        router.refresh();
      } catch (err) {
        toast.error(friendlyError(err, "That email didn’t send — try again?"));
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
          friendlyError(err, "Couldn’t mark that follow-up sent — try again?")
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

  const content = (
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
            <DatePickerButton
              value={scheduledYmd}
              disabled={scheduling}
              minDate={new Date()}
              onSelect={scheduleDate}
              onClear={
                nextFollowUpAt
                  ? () =>
                      startSchedule(async () => {
                        await clearContactFollowUp(contactId);
                        toast.success("Reminder cleared");
                        router.refresh();
                      })
                  : undefined
              }
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
          <div className="mb-2 flex flex-wrap items-center gap-2">
            <p className="text-xs font-medium text-muted-foreground">
              Keep in touch
            </p>
            {cadence ? null : (
              <p className="text-xs text-muted-foreground">Not set</p>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            {KEEP_IN_TOUCH_PRESETS.map((preset) => {
              const active = cadence === preset.days;
              return (
                <Button
                  key={preset.days}
                  type="button"
                  size="sm"
                  variant={active ? "default" : "outline"}
                  disabled={cadencePending}
                  className="h-8 px-2.5"
                  // Clicking the active interval turns it off, so the control needs no
                  // separate "off" button competing with the four that mean something.
                  aria-pressed={active}
                  onClick={() => saveCadence(active ? null : preset.days)}
                >
                  {preset.label}
                </Button>
              );
            })}
          </div>
          <p className="mt-2 text-xs text-muted-foreground">
            {cadence
              ? "Orbit will remind you when it has been this long — and will stop guessing on its own."
              : "Set an interval and Orbit will surface this contact when it lapses."}
          </p>
        </div>

        <div>
          <p className="mb-2 text-xs font-medium text-muted-foreground">
            Draft for
          </p>
          {initialIntent || intent ? (
            <Input
              type="text"
              value={intent}
              onChange={(e) => setIntent(e.target.value)}
              placeholder="Optional intent (e.g. ask for intro)"
              aria-label="Intent"
              className="mb-2 max-w-md"
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
                  className={cn("size-3.5", pending && "motion-safe:animate-spin")}
                />
                Regenerate
              </Button>
            ) : null}
          </div>
        </div>

        {aiError && <AiKeyNotice feature="draft" reason={aiDenialFromMessage(aiError)} compact />}

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
  );

  if (bare) return content;

  return (
    <Card id="follow-up" className="scroll-mt-24">
      <CardHeader>
        <CardTitle as="h2">Follow up</CardTitle>
        <CardDescription>
          Schedule a reminder, or pick a channel to draft a message from your history.
        </CardDescription>
      </CardHeader>
      <CardContent>{content}</CardContent>
    </Card>
  );
}
