"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "@/lib/toast";
import { listContacts, logInteraction } from "@/actions/contacts";
import { scheduleContactFollowUp } from "@/actions/reminders";
import { BulkNotesPanel } from "@/components/chat/bulk-notes-panel";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";

type CaptureMode = "messy" | "structured";

type ContactOption = {
  id: string;
  fullName: string;
  preferredName: string | null;
  company: string | null;
};

const INTERACTION_TYPES = [
  { value: "meeting", label: "Meeting" },
  { value: "call", label: "Call" },
  { value: "email", label: "Email" },
  { value: "message", label: "Message" },
  { value: "coffee", label: "Coffee / hangout" },
  { value: "event", label: "Event" },
  { value: "note", label: "Note" },
] as const;

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
}: {
  initialContactId?: string | null;
  initialContactName?: string | null;
  defaultMode?: CaptureMode;
  hasApiKey?: boolean;
}) {
  const router = useRouter();
  const [mode, setMode] = useState<CaptureMode>(defaultMode);
  const [pending, start] = useTransition();

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
    listContacts()
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
        if (!cancelled) toast.error("Could not load contacts");
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
            active={mode === "messy"}
            onClick={() => setMode("messy")}
          >
            Messy Notes
          </ModeTab>
          <ModeTab
            active={mode === "structured"}
            onClick={() => setMode("structured")}
          >
            Structured Logging
          </ModeTab>
        </div>
        <p className="text-sm text-muted-foreground">
          {mode === "messy"
            ? "Paste notes about one person or many — AI extracts each profile, keeps shared event context, and you review before saving."
            : "Fill in the fields yourself for a clean interaction log on a contact."}
        </p>
      </div>

      {mode === "messy" && (
        <BulkNotesPanel
          preferredContactId={initialContactId}
          preferredContactName={initialContactName}
          hasApiKey={hasApiKey}
          onSaved={(res) => {
            if (res.contactIds.length === 1) {
              router.push(`/contacts/${res.contactIds[0]}`);
            } else {
              router.push("/contacts");
            }
            router.refresh();
          }}
        />
      )}

      {mode === "structured" && (
        <div className="space-y-4 rounded-2xl border border-border/70 bg-card p-6">
          <Field label="Contact">
            {initialContactId ? (
              <p className="rounded-lg border border-border/60 bg-muted/40 px-3 py-2 text-sm font-medium text-primary">
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
                {INTERACTION_TYPES.map((t) => (
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
                  toast.error("Choose a contact");
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
                  toast.success("Interaction logged");
                  router.push(`/contacts/${contactId}`);
                  router.refresh();
                } catch (err) {
                  toast.error(
                    err instanceof Error ? err.message : "Could not save"
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
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={cn(
        "flex-1 rounded-md px-3 py-1.5 text-sm font-medium transition-all sm:flex-none sm:px-4",
        active
          ? "bg-background text-foreground shadow-sm"
          : "text-muted-foreground hover:text-foreground"
      )}
    >
      {children}
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
