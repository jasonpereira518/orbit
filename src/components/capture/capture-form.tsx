"use client";

import { useEffect, useId, useMemo, useRef, useState, useTransition } from "react";
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

function contactLabel(c: ContactOption) {
  const name = c.preferredName || c.fullName;
  return c.company ? `${name} · ${c.company}` : name;
}

function ContactCombobox({
  options,
  value,
  onChange,
  loading,
}: {
  options: ContactOption[];
  value: string;
  onChange: (id: string) => void;
  loading?: boolean;
}) {
  const listId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const selected = options.find((c) => c.id === value) ?? null;
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState(0);

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return options.slice(0, 12);
    return options
      .filter((c) => {
        const hay =
          `${c.fullName} ${c.preferredName ?? ""} ${c.company ?? ""}`.toLowerCase();
        return hay.includes(q);
      })
      .slice(0, 12);
  }, [options, query]);

  useEffect(() => {
    function onPointerDown(event: PointerEvent) {
      if (!rootRef.current?.contains(event.target as Node)) {
        setOpen(false);
        if (selected) setQuery("");
      }
    }
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [selected]);

  function choose(c: ContactOption) {
    onChange(c.id);
    setQuery("");
    setOpen(false);
  }

  const displayValue = open
    ? query
    : selected
      ? contactLabel(selected)
      : query;

  return (
    <div ref={rootRef} className="relative">
      <Input
        role="combobox"
        aria-expanded={open}
        aria-controls={listId}
        aria-autocomplete="list"
        value={displayValue}
        disabled={loading}
        placeholder={loading ? "Loading contacts…" : "Search contacts…"}
        onChange={(e) => {
          setQuery(e.target.value);
          setHighlight(0);
          if (value) onChange("");
          setOpen(true);
        }}
        onFocus={() => {
          setOpen(true);
          if (selected) setQuery("");
        }}
        onKeyDown={(event) => {
          if (!open || matches.length === 0) {
            if (event.key === "ArrowDown" && matches.length > 0) {
              setOpen(true);
              event.preventDefault();
            }
            return;
          }
          if (event.key === "ArrowDown") {
            event.preventDefault();
            setHighlight((h) => (h + 1) % matches.length);
          } else if (event.key === "ArrowUp") {
            event.preventDefault();
            setHighlight((h) => (h - 1 + matches.length) % matches.length);
          } else if (event.key === "Enter" && matches[highlight]) {
            event.preventDefault();
            choose(matches[highlight]!);
          } else if (event.key === "Escape") {
            setOpen(false);
          }
        }}
      />
      {open && matches.length > 0 ? (
        <ul
          id={listId}
          role="listbox"
          className="absolute top-full z-50 mt-1 max-h-56 w-full overflow-auto rounded-lg border border-border bg-popover py-1 text-sm text-popover-foreground shadow-md"
        >
          {matches.map((c, index) => (
            <li key={c.id} role="option" aria-selected={index === highlight}>
              <button
                type="button"
                className={cn(
                  "flex w-full flex-col px-3 py-2.5 text-left transition-colors",
                  index === highlight
                    ? "bg-accent text-accent-foreground"
                    : "hover:bg-muted",
                  c.id === value && "font-medium"
                )}
                onMouseEnter={() => setHighlight(index)}
                onPointerDown={(e) => e.preventDefault()}
                onClick={() => choose(c)}
              >
                <span>{c.preferredName || c.fullName}</span>
                {c.company ? (
                  <span className="text-xs text-muted-foreground">
                    {c.company}
                  </span>
                ) : null}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      {open && !loading && matches.length === 0 && query.trim() ? (
        <p className="absolute top-full z-50 mt-1 w-full rounded-lg border border-border bg-popover px-3 py-2 text-sm text-muted-foreground shadow-md">
          No contacts match “{query.trim()}”
        </p>
      ) : null}
    </div>
  );
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
            onClick={() => {
              setMode("structured");
              if (!initialContactId) setContactsLoading(true);
            }}
          >
            Structured Logging
          </ModeTab>
        </div>
        <p className="text-sm text-muted-foreground sm:hidden">
          {mode === "messy"
            ? "Paste notes — AI extracts profiles for you to review."
            : "Log a clean interaction on a contact."}
        </p>
        <p className="hidden text-sm text-muted-foreground sm:block">
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
              <ContactCombobox
                options={contactOptions}
                value={structuredContactId}
                onChange={setStructuredContactId}
                loading={contactsLoading}
              />
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
            className="w-full bg-primary text-primary-foreground hover:bg-primary/90 sm:w-auto"
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
