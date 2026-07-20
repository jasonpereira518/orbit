"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { createContact, updateContact, type ContactInput } from "@/actions/contacts";
import { MET_CONTEXTS, MET_CONTEXT_LABELS, type MetContext } from "@/lib/met-context";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

export function ContactForm({
  initial,
  contactId,
}: {
  initial?: Partial<ContactInput> & { tags?: string[] };
  contactId?: string;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [form, setForm] = useState({
    fullName: initial?.fullName || "",
    preferredName: initial?.preferredName || "",
    title: initial?.title || "",
    company: initial?.company || "",
    location: initial?.location || "",
    metContext: (initial?.metContext as MetContext | "") || "",
    dateMet: initial?.dateMet
      ? String(initial.dateMet).slice(0, 10)
      : "",
    howMet: initial?.howMet || "",
    email: initial?.email || "",
    phone: initial?.phone || "",
    linkedinUrl: initial?.linkedinUrl || "",
    website: initial?.website || "",
    notes: initial?.notes || "",
    relationshipScore: initial?.relationshipScore ?? 2,
    priorityLevel: initial?.priorityLevel ?? 0,
    tagNames: (initial?.tagNames || initial?.tags || []).join(", "),
  });

  function set<K extends keyof typeof form>(key: K, value: (typeof form)[K]) {
    setForm((f) => ({ ...f, [key]: value }));
  }

  return (
    <form
      className="space-y-4 rounded-2xl border border-border/70 bg-card p-6"
      onSubmit={(e) => {
        e.preventDefault();
        start(async () => {
          try {
            const payload: ContactInput = {
              fullName: form.fullName.trim(),
              preferredName: form.preferredName.trim(),
              title: form.title.trim(),
              company: form.company.trim(),
              location: form.location.trim(),
              metContext: form.metContext || undefined,
              dateMet: form.dateMet || null,
              howMet: form.howMet.trim(),
              email: form.email.trim(),
              phone: form.phone.trim(),
              linkedinUrl: form.linkedinUrl.trim(),
              website: form.website.trim(),
              notes: form.notes.trim(),
              relationshipScore: Number(form.relationshipScore),
              priorityLevel: Number(form.priorityLevel),
              tagNames: form.tagNames
                .split(",")
                .map((t) => t.trim())
                .filter(Boolean),
            };
            if (contactId) {
              await updateContact(contactId, payload);
              toast.success("Contact updated");
              router.push(`/contacts/${contactId}`);
            } else {
              const c = await createContact(payload);
              toast.success("Contact created");
              router.push(`/contacts/${c.id}`);
            }
            router.refresh();
          } catch (err) {
            toast.error(err instanceof Error ? err.message : "Failed to save");
          }
        });
      }}
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Full name" required>
          <Input
            required
            value={form.fullName}
            onChange={(e) => set("fullName", e.target.value)}
            placeholder="Arvind Rao"
          />
        </Field>
        <Field label="Preferred name">
          <Input
            value={form.preferredName}
            onChange={(e) => set("preferredName", e.target.value)}
            placeholder="Arvind"
          />
        </Field>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Company">
          <Input
            value={form.company}
            onChange={(e) => set("company", e.target.value)}
            placeholder="AWS"
          />
        </Field>
        <Field label="Role">
          <Input
            value={form.title}
            onChange={(e) => set("title", e.target.value)}
            placeholder="Solutions Architect"
          />
        </Field>
      </div>
      <Field label="Location">
        <Input
          value={form.location}
          onChange={(e) => set("location", e.target.value)}
          placeholder="New York, NY"
        />
      </Field>
      <div className="space-y-4 rounded-xl border border-border/60 bg-muted/20 p-4">
        <div>
          <p className="text-sm font-medium text-primary">How you met</p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Context, when it happened, and any details you want to remember.
          </p>
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Context">
            <select
              className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
              value={form.metContext}
              onChange={(e) =>
                set("metContext", e.target.value as MetContext | "")
              }
            >
              <option value="">Select…</option>
              {MET_CONTEXTS.map((value) => (
                <option key={value} value={value}>
                  {MET_CONTEXT_LABELS[value]}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Date met">
            <Input
              type="date"
              value={form.dateMet}
              onChange={(e) => set("dateMet", e.target.value)}
            />
          </Field>
        </div>
        <Field label="Details">
          <Textarea
            rows={2}
            value={form.howMet}
            onChange={(e) => set("howMet", e.target.value)}
            placeholder="Google NYC event, introduced by Alex, coffee chat about internships…"
          />
        </Field>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Email">
          <Input
            type="email"
            value={form.email}
            onChange={(e) => set("email", e.target.value)}
            placeholder="arvind@example.com"
          />
        </Field>
        <Field label="Phone">
          <Input
            type="tel"
            value={form.phone}
            onChange={(e) => set("phone", e.target.value)}
            placeholder="+1 555 123 4567"
          />
        </Field>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="LinkedIn URL">
          <Input
            type="url"
            value={form.linkedinUrl}
            onChange={(e) => set("linkedinUrl", e.target.value)}
            placeholder="https://linkedin.com/in/..."
          />
        </Field>
        <Field label="Website">
          <Input
            type="url"
            value={form.website}
            onChange={(e) => set("website", e.target.value)}
            placeholder="https://..."
          />
        </Field>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Closeness (1–5)">
          <Input
            type="number"
            min={1}
            max={5}
            value={form.relationshipScore}
            onChange={(e) => set("relationshipScore", Number(e.target.value))}
          />
        </Field>
        <Field label="Priority (0–3)">
          <Input
            type="number"
            min={0}
            max={3}
            value={form.priorityLevel}
            onChange={(e) => set("priorityLevel", Number(e.target.value))}
          />
        </Field>
      </div>
      <Field label="Tags (comma-separated)">
        <Input
          value={form.tagNames}
          onChange={(e) => set("tagNames", e.target.value)}
          placeholder="AI, OpenAI, internship"
        />
      </Field>
      <Field label="Notes">
        <Textarea
          rows={4}
          value={form.notes}
          onChange={(e) => set("notes", e.target.value)}
        />
      </Field>
      <Button
        type="submit"
        disabled={pending}
        className="bg-primary text-primary-foreground hover:bg-primary/90"
      >
        {pending ? "Saving…" : contactId ? "Save changes" : "Create contact"}
      </Button>
    </form>
  );
}

function Field({
  label,
  children,
  required,
}: {
  label: string;
  children: React.ReactNode;
  required?: boolean;
}) {
  return (
    <div className="space-y-1.5">
      <Label>
        {label}
        {required ? " *" : ""}
      </Label>
      {children}
    </div>
  );
}
