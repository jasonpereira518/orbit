"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { parseCaptureNotes, confirmCapture } from "@/actions/capture";
import { listContacts, logInteraction } from "@/actions/contacts";
import { scheduleContactFollowUp } from "@/actions/reminders";
import type { ParsedNote } from "@/lib/ai";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

type Dup = {
  id: string;
  fullName: string;
  company: string | null;
  title: string | null;
  reason: string;
  confidence: number;
};

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
}: {
  initialContactId?: string | null;
  initialContactName?: string | null;
  defaultMode?: CaptureMode;
}) {
  const router = useRouter();
  const [mode, setMode] = useState<CaptureMode>(defaultMode);
  const [notes, setNotes] = useState("");
  const [step, setStep] = useState<"paste" | "review">("paste");
  const [parsed, setParsed] = useState<ParsedNote | null>(null);
  const [duplicates, setDuplicates] = useState<Dup[]>([]);
  const [mergeId, setMergeId] = useState<string | null>(initialContactId);
  const [createReminder, setCreateReminder] = useState(true);
  const [score, setScore] = useState(2);
  const [tags, setTags] = useState("");
  const [followUpDays, setFollowUpDays] = useState(14);
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
            onClick={() => {
              setMode("messy");
              setStep("paste");
            }}
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
            ? "Paste rough notes — AI extracts people, topics, and follow-ups for you to confirm."
            : "Fill in the fields yourself for a clean interaction log on a contact."}
        </p>
      </div>

      {mode === "messy" && step === "paste" && (
        <div className="space-y-4 rounded-2xl border border-border/70 bg-card p-6">
          {initialContactId && initialContactName && (
            <p className="rounded-xl bg-muted/50 px-3 py-2 text-sm text-muted-foreground">
              Logging against{" "}
              <span className="font-medium text-foreground">
                {initialContactName}
              </span>
              . After extraction you can merge into this contact.
            </p>
          )}
          <div>
            <Label htmlFor="notes">Paste rough notes</Label>
            <Textarea
              id="notes"
              className="mt-2 min-h-[200px]"
              placeholder="Met Sarah Chen at AWS Summit. She works at OpenAI on Codex partnerships..."
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
            />
          </div>
          <Button
            disabled={pending || !notes.trim()}
            className="bg-primary text-primary-foreground hover:bg-primary/90"
            onClick={() =>
              start(async () => {
                try {
                  const res = await parseCaptureNotes(notes);
                  setParsed(res.parsed);
                  setDuplicates(res.duplicates);
                  setScore(res.parsed.relationship_score_suggestion || 2);
                  setTags((res.parsed.tags || []).join(", "));
                  setFollowUpDays(res.parsed.follow_up_days || 14);
                  setCreateReminder(Boolean(res.parsed.follow_up_recommendation));
                  const preferredMerge =
                    (initialContactId &&
                      res.duplicates.some((d) => d.id === initialContactId) &&
                      initialContactId) ||
                    res.duplicates[0]?.id ||
                    initialContactId ||
                    null;
                  setMergeId(preferredMerge);
                  setStep("review");
                } catch (err) {
                  toast.error(
                    err instanceof Error ? err.message : "Failed to parse notes"
                  );
                }
              })
            }
          >
            {pending ? "Parsing…" : "Extract with AI"}
          </Button>
        </div>
      )}

      {mode === "messy" && step === "review" && parsed && (
        <div className="space-y-4 rounded-2xl border border-border/70 bg-card p-6">
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-medium text-primary">Review extraction</h2>
            <Button variant="ghost" onClick={() => setStep("paste")}>
              Back
            </Button>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Name">
              <Input
                value={parsed.name || ""}
                onChange={(e) => setParsed({ ...parsed, name: e.target.value })}
              />
            </Field>
            <Field label="Company">
              <Input
                value={parsed.company || ""}
                onChange={(e) =>
                  setParsed({ ...parsed, company: e.target.value })
                }
              />
            </Field>
            <Field label="Role">
              <Input
                value={parsed.role || ""}
                onChange={(e) => setParsed({ ...parsed, role: e.target.value })}
              />
            </Field>
            <Field label="Met at">
              <Input
                value={parsed.met_at || ""}
                onChange={(e) =>
                  setParsed({ ...parsed, met_at: e.target.value })
                }
              />
            </Field>
          </div>

          <Field label="Summary">
            <Textarea
              value={parsed.summary || ""}
              onChange={(e) =>
                setParsed({ ...parsed, summary: e.target.value })
              }
            />
          </Field>

          <div className="flex flex-wrap gap-2">
            {(parsed.topics || []).map((t) => (
              <Badge key={t} variant="secondary">
                {t}
              </Badge>
            ))}
          </div>

          {(duplicates.length > 0 || initialContactId) && (
            <div className="rounded-xl border border-amber-200 bg-amber-50/50 p-4 dark:border-amber-900/50 dark:bg-amber-950/20">
              <p className="mb-2 text-sm font-medium">Save to contact</p>
              <div className="space-y-2">
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="radio"
                    name="merge"
                    checked={!mergeId}
                    onChange={() => setMergeId(null)}
                  />
                  Create new contact
                </label>
                {initialContactId &&
                  initialContactName &&
                  !duplicates.some((d) => d.id === initialContactId) && (
                    <label className="flex items-center gap-2 text-sm">
                      <input
                        type="radio"
                        name="merge"
                        checked={mergeId === initialContactId}
                        onChange={() => setMergeId(initialContactId)}
                      />
                      Merge into {initialContactName}
                    </label>
                  )}
                {duplicates.map((d) => (
                  <label key={d.id} className="flex items-center gap-2 text-sm">
                    <input
                      type="radio"
                      name="merge"
                      checked={mergeId === d.id}
                      onChange={() => setMergeId(d.id)}
                    />
                    Merge into {d.fullName}
                    {d.company ? ` (${d.company})` : ""} — {d.reason}
                  </label>
                ))}
              </div>
            </div>
          )}

          <div className="grid gap-4 sm:grid-cols-3">
            <Field label="Closeness score">
              <Input
                type="number"
                min={1}
                max={5}
                value={score}
                onChange={(e) => setScore(Number(e.target.value))}
              />
            </Field>
            <Field label="Follow-up days">
              <Input
                type="number"
                min={1}
                value={followUpDays}
                onChange={(e) => setFollowUpDays(Number(e.target.value))}
              />
            </Field>
            <Field label="Tags">
              <Input value={tags} onChange={(e) => setTags(e.target.value)} />
            </Field>
          </div>

          {parsed.follow_up_recommendation && (
            <p className="text-sm text-muted-foreground">
              Suggested: {parsed.follow_up_recommendation}
            </p>
          )}

          <label className="flex items-center gap-2 text-sm">
            <Checkbox
              checked={createReminder}
              onCheckedChange={(v) => setCreateReminder(Boolean(v))}
            />
            Create follow-up reminder (you confirm — AI only suggests)
          </label>

          <Button
            disabled={pending}
            className="bg-primary text-primary-foreground hover:bg-primary/90"
            onClick={() =>
              start(async () => {
                try {
                  const res = await confirmCapture({
                    notes,
                    parsed,
                    mergeContactId: mergeId,
                    createReminder,
                    relationshipScore: score,
                    tagNames: tags
                      .split(",")
                      .map((t) => t.trim())
                      .filter(Boolean),
                    followUpDays,
                  });
                  toast.success("Saved to your network");
                  router.push(`/contacts/${res.contactId}`);
                  router.refresh();
                } catch (err) {
                  toast.error(err instanceof Error ? err.message : "Save failed");
                }
              })
            }
          >
            {pending ? "Saving…" : "Confirm & save"}
          </Button>
        </div>
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
