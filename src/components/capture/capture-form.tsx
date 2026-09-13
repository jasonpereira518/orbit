"use client";

import { useEffect, useState, useSyncExternalStore, useTransition } from "react";
import { useRouter } from "next/navigation";
import { motion } from "motion/react";
import { SPRING_PILL } from "@/lib/motion";
import { toast } from "@/lib/toast";
import { logInteraction, searchContactsForPicker } from "@/actions/contacts";
import { scheduleContactFollowUp } from "@/actions/reminders";
import { BulkNotesPanel } from "@/components/chat/bulk-notes-panel";
import { MeetingCapturePanel } from "@/components/capture/meeting-capture-panel";
import type { ResumableMeeting } from "@/lib/meeting-sessions";
import { isMeetingCaptureSupported } from "@/lib/use-meeting-recorder";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { SELECTABLE_INTERACTION_TYPES } from "@/lib/interaction-types";
import { captureDraftKey } from "@/lib/capture-draft";
import { CAPTURE_HANDOFF_EVENT } from "@/lib/capture-handoff";
import { friendlyError } from "@/lib/errors";
import { TOAST_COPY } from "@/lib/toast-copy";

export type CaptureMode = "voice" | "messy" | "structured" | "meeting";

/**
 * Whether this browser can record a call. Only knowable on the client, so the server
 * snapshot is `false` and the tab appears after hydration rather than flashing in and out.
 */
function useMeetingCaptureSupported(): boolean {
  return useSyncExternalStore(
    (onChange) => {
      const mq = window.matchMedia("(min-width: 768px) and (pointer: fine)");
      mq.addEventListener("change", onChange);
      return () => mq.removeEventListener("change", onChange);
    },
    isMeetingCaptureSupported,
    () => false
  );
}

type ContactOption = {
  id: string;
  fullName: string;
  preferredName: string | null;
  company: string | null;
};

function todayInputValue() {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function CaptureForm({
  initialContactId = null,
  initialContactName = null,
  defaultMode = "messy",
  hasApiKey = true,
  userId,
  canTranscribe = false,
  resumableMeeting = null,
}: {
  initialContactId?: string | null;
  initialContactName?: string | null;
  defaultMode?: CaptureMode;
  hasApiKey?: boolean;
  userId: string;
  /** An OpenAI, Gemini or Wispr key exists — what meeting capture transcribes with. */
  canTranscribe?: boolean;
  /** An unfinished recorded meeting, offered for resuming on the Meeting tab. */
  resumableMeeting?: ResumableMeeting | null;
}) {
  const router = useRouter();
  const [mode, setMode] = useState<CaptureMode>(defaultMode);
  const [pending, start] = useTransition();
  // One draft for Voice and Messy alike: switching tabs remounts the panel, and the text
  // typed under one should still be there under the other.
  const draftKey = captureDraftKey(userId, initialContactId);
  const acceptsHandoff = !initialContactId;

  // "Capture this" from the palette while Structured is open: there is no notes panel on
  // that tab to take the text, so switch to the one that has — it takes the waiting
  // handoff as it mounts.
  useEffect(() => {
    if (!acceptsHandoff) return;
    function onHandoff() {
      setMode((m) => (m === "structured" ? "messy" : m));
    }
    window.addEventListener(CAPTURE_HANDOFF_EVENT, onHandoff);
    return () => window.removeEventListener(CAPTURE_HANDOFF_EVENT, onHandoff);
  }, [acceptsHandoff]);

  const meetingSupported = useMeetingCaptureSupported();
  // A meeting on the server can be summarized from any browser; only recording needs
  // desktop Chromium. So the tab shows for either reason.
  const showMeetingTab = meetingSupported || Boolean(resumableMeeting) || mode === "meeting";
  // Switching tabs unmounts the recorder — mid-call, that would stop the recording.
  const [meetingBusy, setMeetingBusy] = useState(false);

  const [contactOptions, setContactOptions] = useState<ContactOption[]>(() =>
    initialContactId
      ? [
          {
            id: initialContactId,
            fullName: initialContactName || "Selected contact",
            preferredName: initialContactName,
            company: null,
          },
        ]
      : []
  );
  const [structuredContactId, setStructuredContactId] = useState(
    initialContactId || ""
  );
  const [interactionDate, setInteractionDate] = useState(todayInputValue);
  const [interactionType, setInteractionType] = useState<string>("meeting");
  const [structuredNotes, setStructuredNotes] = useState("");
  const [structuredTopics, setStructuredTopics] = useState("");
  const [structuredFollowUp, setStructuredFollowUp] = useState(false);
  const [structuredFollowUpDays, setStructuredFollowUpDays] = useState(7);
  const [contactsLoading, setContactsLoading] = useState(false);

  useEffect(() => {
    if (mode !== "structured" || initialContactId) return;
    let cancelled = false;
    setContactsLoading(true);
    searchContactsForPicker()
      .then((rows) => {
        if (cancelled) return;
        setContactOptions(
          rows.map((c) => ({
            id: c.id,
            fullName: c.fullName,
            preferredName: c.preferredName,
            company: c.company,
          }))
        );
      })
      .catch(() => {
        if (!cancelled) toast.error(TOAST_COPY.loadContactsFailed);
      })
      .finally(() => {
        if (!cancelled) setContactsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [mode, initialContactId]);

  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <Label className="text-muted-foreground">Logging style</Label>
        <div
          role="tablist"
          aria-label="Capture mode"
          className="inline-flex w-full rounded-lg bg-muted p-[3px] sm:w-auto"
        >
          <ModeTab
            active={mode === "voice"}
            disabled={meetingBusy}
            onClick={() => setMode("voice")}
          >
            Voice
          </ModeTab>
          {showMeetingTab && (
            <ModeTab
              active={mode === "meeting"}
              disabled={meetingBusy}
              onClick={() => setMode("meeting")}
            >
              Meeting
            </ModeTab>
          )}
          <ModeTab
            active={mode === "messy"}
            disabled={meetingBusy}
            onClick={() => setMode("messy")}
          >
            Messy Notes
          </ModeTab>
          <ModeTab
            active={mode === "structured"}
            disabled={meetingBusy}
            onClick={() => setMode("structured")}
          >
            Structured Logging
          </ModeTab>
        </div>
        <p className="text-sm text-muted-foreground">
          {mode === "voice" &&
            "Just finished a conversation? Say who you met and what you agreed — Orbit transcribes it, pulls out the people, and turns \"ping her in two weeks\" into a reminder."}
          {mode === "meeting" &&
            "On a Zoom or Google Meet call? Keep this tab open and Orbit listens along — then summarizes the call and pulls out the people, next steps, blockers and open questions."}
          {mode === "messy" &&
            "Paste notes about one person or many — AI extracts each profile, keeps shared event context, and you review before saving."}
          {mode === "structured" &&
            "Fill in the fields yourself for a clean interaction log on a contact."}
        </p>
      </div>

      {(mode === "voice" || mode === "messy") && (
        <BulkNotesPanel
          // Remounting on mode change is deliberate: carrying a half-reviewed parse across
          // a tab switch would leave the user looking at cards they can no longer explain.
          key={mode}
          showRecorder={mode === "voice"}
          preferredContactId={initialContactId}
          preferredContactName={initialContactName}
          hasApiKey={hasApiKey}
          draftKey={draftKey}
          acceptsHandoff={acceptsHandoff}
          onSaved={(res) => {
            router.push(`/capture/${res.batchId}`);
          }}
        />
      )}

      {mode === "meeting" && (
        <MeetingCapturePanel
          resumable={resumableMeeting}
          hasApiKey={hasApiKey}
          canTranscribe={canTranscribe}
          captureSupported={meetingSupported}
          onBusyChange={setMeetingBusy}
        />
      )}

      {mode === "structured" && (
        <div className="space-y-4 rounded-2xl border border-border/70 bg-card p-6">
          <Field label="Contact">
            {initialContactId ? (
              <p className="rounded-lg border border-border/60 bg-muted/40 px-3 py-2 text-sm font-medium text-ink">
                {initialContactName || "Selected contact"}
              </p>
            ) : (
              <select
                className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
                value={structuredContactId}
                disabled={contactsLoading}
                onChange={(e) => setStructuredContactId(e.target.value)}
              >
                <option value="">
                  {contactsLoading ? "Loading contacts…" : "Select a contact"}
                </option>
                {contactOptions.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.preferredName || c.fullName}
                    {c.company ? ` · ${c.company}` : ""}
                  </option>
                ))}
              </select>
            )}
          </Field>

          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Date">
              <Input
                type="date"
                value={interactionDate}
                onChange={(e) => setInteractionDate(e.target.value)}
              />
            </Field>
            <Field label="Type">
              <select
                className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
                value={interactionType}
                onChange={(e) => setInteractionType(e.target.value)}
              >
                {SELECTABLE_INTERACTION_TYPES.map((t) => (
                  <option key={t.value} value={t.value}>
                    {t.label}
                  </option>
                ))}
              </select>
            </Field>
          </div>

          <Field label="What happened">
            <Textarea
              className="min-h-[140px]"
              placeholder="Talked through Q3 hiring, offered an intro to Maya at Stripe…"
              value={structuredNotes}
              onChange={(e) => setStructuredNotes(e.target.value)}
            />
          </Field>

          <Field label="Topics">
            <Input
              placeholder="hiring, intros, product (comma-separated)"
              value={structuredTopics}
              onChange={(e) => setStructuredTopics(e.target.value)}
            />
          </Field>

          <label className="flex items-center gap-2 text-sm">
            <Checkbox
              checked={structuredFollowUp}
              onCheckedChange={(v) => setStructuredFollowUp(Boolean(v))}
            />
            Schedule a follow-up
          </label>

          {structuredFollowUp && (
            <Field label="Follow-up in (days)">
              <Input
                type="number"
                min={1}
                max={90}
                value={structuredFollowUpDays}
                onChange={(e) =>
                  setStructuredFollowUpDays(Number(e.target.value) || 7)
                }
              />
            </Field>
          )}

          <Button
            disabled={
              pending ||
              !structuredNotes.trim() ||
              !(initialContactId || structuredContactId)
            }
            className="bg-primary text-primary-foreground hover:bg-primary/90"
            onClick={() =>
              start(async () => {
                const contactId = initialContactId || structuredContactId;
                if (!contactId) {
                  toast.error("Pick a contact first");
                  return;
                }
                try {
                  await logInteraction({
                    contactId,
                    rawNotes: structuredNotes.trim(),
                    topics: structuredTopics
                      .split(",")
                      .map((t) => t.trim())
                      .filter(Boolean),
                    interactionType,
                    interactionDate,
                    source: "structured_capture",
                  });
                  if (structuredFollowUp) {
                    await scheduleContactFollowUp(
                      contactId,
                      structuredFollowUpDays
                    );
                  }
                  toast.success("Logged");
                  router.push(`/contacts/${contactId}`);
                  router.refresh();
                } catch (err) {
                  toast.error(
                    friendlyError(err, TOAST_COPY.saveFailed)
                  );
                }
              })
            }
          >
            {pending ? "Saving…" : "Save interaction"}
          </Button>
        </div>
      )}
    </div>
  );
}

function ModeTab({
  active,
  onClick,
  disabled = false,
  children,
}: {
  active: boolean;
  onClick: () => void;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      disabled={disabled && !active}
      onClick={onClick}
      className={cn(
        "relative flex-1 rounded-md px-3 py-1.5 text-sm font-medium transition-colors sm:flex-none sm:px-4",
        active ? "text-foreground" : "text-muted-foreground hover:text-foreground",
        "disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:text-muted-foreground"
      )}
    >
      {active && (
        <motion.span
          layoutId="capture-mode-pill"
          className="absolute inset-0 rounded-md bg-background shadow-sm"
          transition={SPRING_PILL}
        />
      )}
      <span className="relative z-10">{children}</span>
    </button>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <Label>{label}</Label>
      {children}
    </div>
  );
}
