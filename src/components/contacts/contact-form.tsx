"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { createContact, updateContact, type ContactInput } from "@/actions/contacts";
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
    title: initial?.title || "",
    company: initial?.company || "",
    email: initial?.email || "",
    linkedinUrl: initial?.linkedinUrl || "",
    location: initial?.location || "",
    howMet: initial?.howMet || "",
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
      className="space-y-4 rounded-2xl border border-border/70 bg-white p-6"
      onSubmit={(e) => {
        e.preventDefault();
        start(async () => {
          try {
            const payload: ContactInput = {
              fullName: form.fullName,
              title: form.title || undefined,
              company: form.company || undefined,
              email: form.email || undefined,
              linkedinUrl: form.linkedinUrl || undefined,
              location: form.location || undefined,
              howMet: form.howMet || undefined,
              notes: form.notes || undefined,
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
      <Field label="Full name" required>
        <Input
          required
          value={form.fullName}
          onChange={(e) => set("fullName", e.target.value)}
        />
      </Field>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Title">
          <Input value={form.title} onChange={(e) => set("title", e.target.value)} />
        </Field>
        <Field label="Company">
          <Input
            value={form.company}
            onChange={(e) => set("company", e.target.value)}
          />
        </Field>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Email">
          <Input
            type="email"
            value={form.email}
            onChange={(e) => set("email", e.target.value)}
          />
        </Field>
        <Field label="LinkedIn URL">
          <Input
            value={form.linkedinUrl}
            onChange={(e) => set("linkedinUrl", e.target.value)}
          />
        </Field>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Location">
          <Input
            value={form.location}
            onChange={(e) => set("location", e.target.value)}
          />
        </Field>
        <Field label="How you met">
          <Input value={form.howMet} onChange={(e) => set("howMet", e.target.value)} />
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
        className="bg-[#0f3d3e] hover:bg-[#0c3233]"
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
