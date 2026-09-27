"use client";

/**
 * The one capture path with no model in it: pick a contact, say what happened, save.
 * Moved out of the old `capture-form.tsx` unchanged in behaviour; only the shell around
 * it is new.
 */
import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { logInteraction, searchContactsForPicker } from "@/actions/contacts";
import { scheduleContactFollowUp } from "@/actions/reminders";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { friendlyError } from "@/lib/errors";
import { SELECTABLE_INTERACTION_TYPES } from "@/lib/interaction-types";
import { toast } from "@/lib/toast";
import { TOAST_COPY } from "@/lib/toast-copy";

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

const SELECT_CLASS =
  "flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50";

export function StructuredCaptureForm({
  initialContactId = null,
  initialContactName = null,
}: {
  initialContactId?: string | null;
  initialContactName?: string | null;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [contactOptions, setContactOptions] = useState<ContactOption[]>(() =>
    initialContactId
      ? [{ id: initialContactId, fullName: initialContactName || "Selected contact", preferredName: initialContactName, company: null }]
      : []
  );
  const [contactId, setContactId] = useState(initialContactId || "");
  const [interactionDate, setInteractionDate] = useState(todayInputValue);
  const [interactionType, setInteractionType] = useState<string>("meeting");
  const [notes, setNotes] = useState("");
  const [topics, setTopics] = useState("");
  const [followUp, setFollowUp] = useState(false);
  const [followUpDays, setFollowUpDays] = useState(7);
  const [contactsLoading, setContactsLoading] = useState(false);

  useEffect(() => {
    if (initialContactId) return;
    let cancelled = false;
    setContactsLoading(true);
    searchContactsForPicker()
      .then((rows) => {
        if (cancelled) return;
        setContactOptions(rows.map((c) => ({ id: c.id, fullName: c.fullName, preferredName: c.preferredName, company: c.company })));
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
  }, [initialContactId]);

  const chosen = initialContactId || contactId;

  return (
    <div className="space-y-4 rounded-2xl border border-border/70 bg-card p-5 sm:p-6">
      <Field label="Contact">
        {initialContactId ? (
          <p className="rounded-lg border border-border/60 bg-muted/40 px-3 py-2 text-sm font-medium text-ink">
            {initialContactName || "Selected contact"}
          </p>
        ) : (
          <select className={SELECT_CLASS} value={contactId} disabled={contactsLoading} onChange={(e) => setContactId(e.target.value)}>
            <option value="">{contactsLoading ? "Loading contacts…" : "Select a contact"}</option>
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
          <Input type="date" value={interactionDate} onChange={(e) => setInteractionDate(e.target.value)} />
        </Field>
        <Field label="Type">
          <select className={SELECT_CLASS} value={interactionType} onChange={(e) => setInteractionType(e.target.value)}>
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
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
        />
      </Field>

      <Field label="Topics">
        <Input placeholder="hiring, intros, product (comma-separated)" value={topics} onChange={(e) => setTopics(e.target.value)} />
      </Field>

      <label className="flex items-center gap-2 text-sm">
        <Checkbox checked={followUp} onCheckedChange={(v) => setFollowUp(Boolean(v))} />
        Schedule a follow-up
      </label>

      {followUp && (
        <Field label="Follow-up in (days)">
          <Input type="number" min={1} max={90} value={followUpDays} onChange={(e) => setFollowUpDays(Number(e.target.value) || 7)} />
        </Field>
      )}

      <Button
        disabled={pending || !notes.trim() || !chosen}
        className="w-full bg-primary text-primary-foreground hover:bg-primary/90 sm:w-auto"
        onClick={() =>
          start(async () => {
            if (!chosen) {
              toast.error("Pick a contact first");
              return;
            }
            try {
              await logInteraction({
                contactId: chosen,
                rawNotes: notes.trim(),
                topics: topics.split(",").map((t) => t.trim()).filter(Boolean),
                interactionType,
                interactionDate,
                source: "structured_capture",
              });
              if (followUp) await scheduleContactFollowUp(chosen, followUpDays);
              toast.success("Logged");
              router.push(`/contacts/${chosen}`);
              router.refresh();
            } catch (err) {
              toast.error(friendlyError(err, TOAST_COPY.saveFailed));
            }
          })
        }
      >
        {pending ? "Saving…" : "Save interaction"}
      </Button>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <Label>{label}</Label>
      {children}
    </div>
  );
}
