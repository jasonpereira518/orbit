"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { logRecruiter } from "@/actions/recruiters";
import { Button } from "@/components/ui/button";
import { FormField } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "@/lib/toast";
import { cn } from "@/lib/utils";
import type { RecruiterLinkStatus } from "@/db/schema";
import { friendlyError } from "@/lib/errors";

/** Stored link status → the word in the menu. The stored values never change. */
const STATUS_ITEMS: Array<{ value: RecruiterLinkStatus; label: string }> = [
  { value: "planned", label: "Planned" },
  { value: "contacted", label: "Contacted" },
  { value: "active", label: "Active" },
  { value: "archived", label: "Archived" },
];

export function RecruiterLogForm({
  initial,
  recruiterId,
  className,
}: {
  initial?: {
    fullName?: string;
    firm?: string;
    specialty?: string;
    email?: string;
    linkedinUrl?: string;
    phone?: string;
    notes?: string;
    status?: RecruiterLinkStatus;
    personalRating?: number;
  };
  recruiterId?: string;
  className?: string;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [form, setForm] = useState({
    fullName: initial?.fullName || "",
    firm: initial?.firm || "",
    specialty: initial?.specialty || "",
    email: initial?.email || "",
    linkedinUrl: initial?.linkedinUrl || "",
    phone: initial?.phone || "",
    notes: initial?.notes || "",
    status: (initial?.status || "planned") as RecruiterLinkStatus,
    personalRating: initial?.personalRating
      ? String(initial.personalRating)
      : "",
  });

  function set<K extends keyof typeof form>(key: K, value: (typeof form)[K]) {
    setForm((f) => ({ ...f, [key]: value }));
  }

  return (
    <form
      className={cn("space-y-4", className)}
      onSubmit={(e) => {
        e.preventDefault();
        start(async () => {
          try {
            const specialty = form.specialty
              .split(",")
              .map((s) => s.trim())
              .filter(Boolean);
            const rating = form.personalRating
              ? Number(form.personalRating)
              : undefined;
            const result = await logRecruiter({
              recruiterId,
              fullName: form.fullName,
              firm: form.firm || undefined,
              specialty,
              email: form.email || undefined,
              linkedinUrl: form.linkedinUrl || undefined,
              phone: form.phone || undefined,
              notes: form.notes || undefined,
              status: form.status,
              personalRating: rating,
              source: "manual",
            });
            if (!result.ok) {
              toast.error(result.error);
              return;
            }
            toast.success("Recruiter logged");
            router.push(`/recruiters/${result.value.id}`);
            router.refresh();
          } catch (err) {
            toast.error(
              friendlyError(err, "Couldn’t log that recruiter — try again?")
            );
          }
        });
      }}
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <FormField label="Name" id="fullName" required={!recruiterId} className="sm:col-span-2">
          <Input
            id="fullName"
            required={!recruiterId}
            value={form.fullName}
            onChange={(e) => set("fullName", e.target.value)}
            placeholder="Jordan Lee"
            disabled={Boolean(recruiterId) && Boolean(initial?.fullName)}
          />
        </FormField>
        <FormField label="Firm / agency" id="firm">
          <Input
            id="firm"
            value={form.firm}
            onChange={(e) => set("firm", e.target.value)}
            placeholder="Acme Talent"
          />
        </FormField>
        <FormField label="Specialty" id="specialty" hint="Comma-separated.">
          <Input
            id="specialty"
            value={form.specialty}
            onChange={(e) => set("specialty", e.target.value)}
            placeholder="Engineering, AI"
          />
        </FormField>
        <FormField label="Email" id="email">
          <Input
            id="email"
            type="email"
            value={form.email}
            onChange={(e) => set("email", e.target.value)}
          />
        </FormField>
        <FormField label="Phone" id="phone">
          <Input
            id="phone"
            value={form.phone}
            onChange={(e) => set("phone", e.target.value)}
          />
        </FormField>
        <FormField label="LinkedIn" id="linkedinUrl" className="sm:col-span-2">
          <Input
            id="linkedinUrl"
            value={form.linkedinUrl}
            onChange={(e) => set("linkedinUrl", e.target.value)}
            placeholder="https://linkedin.com/in/…"
          />
        </FormField>
        <FormField label="Status" id="status">
          <Select
            value={form.status}
            onValueChange={(v) => set("status", (v ?? "planned") as RecruiterLinkStatus)}
            items={STATUS_ITEMS}
          >
            <SelectTrigger id="status" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {STATUS_ITEMS.map((s) => (
                <SelectItem key={s.value} value={s.value}>
                  {s.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </FormField>
        <FormField label="Your rating (1–5)" id="rating">
          <Input
            id="rating"
            type="number"
            min={1}
            max={5}
            value={form.personalRating}
            onChange={(e) => set("personalRating", e.target.value)}
          />
        </FormField>
        <FormField label="Private notes" id="notes" className="sm:col-span-2">
          <Textarea
            id="notes"
            value={form.notes}
            onChange={(e) => set("notes", e.target.value)}
            rows={3}
            placeholder="Where you met, roles they place, etc."
          />
        </FormField>
      </div>
      <div className="flex justify-end">
        <Button type="submit" disabled={pending}>
          {pending ? "Saving…" : recruiterId ? "Log interaction" : "Add recruiter"}
        </Button>
      </div>
    </form>
  );
}
