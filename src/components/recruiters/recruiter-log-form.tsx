"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { logRecruiter } from "@/actions/recruiters";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "@/lib/toast";
import { cn } from "@/lib/utils";
import type { RecruiterLinkStatus } from "@/db/schema";

const STATUSES: RecruiterLinkStatus[] = [
  "planned",
  "contacted",
  "active",
  "archived",
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
            toast.success("Recruiter logged");
            router.push(`/recruiters/${result.id}`);
            router.refresh();
          } catch (err) {
            toast.error(
              err instanceof Error ? err.message : "Failed to log recruiter"
            );
          }
        });
      }}
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1.5 sm:col-span-2">
          <Label htmlFor="fullName">Name</Label>
          <Input
            id="fullName"
            required={!recruiterId}
            value={form.fullName}
            onChange={(e) => set("fullName", e.target.value)}
            placeholder="Jordan Lee"
            disabled={Boolean(recruiterId) && Boolean(initial?.fullName)}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="firm">Firm / agency</Label>
          <Input
            id="firm"
            value={form.firm}
            onChange={(e) => set("firm", e.target.value)}
            placeholder="Acme Talent"
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="specialty">Specialty (comma-separated)</Label>
          <Input
            id="specialty"
            value={form.specialty}
            onChange={(e) => set("specialty", e.target.value)}
            placeholder="Engineering, AI"
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="email">Email</Label>
          <Input
            id="email"
            type="email"
            value={form.email}
            onChange={(e) => set("email", e.target.value)}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="phone">Phone</Label>
          <Input
            id="phone"
            value={form.phone}
            onChange={(e) => set("phone", e.target.value)}
          />
        </div>
        <div className="space-y-1.5 sm:col-span-2">
          <Label htmlFor="linkedinUrl">LinkedIn</Label>
          <Input
            id="linkedinUrl"
            value={form.linkedinUrl}
            onChange={(e) => set("linkedinUrl", e.target.value)}
            placeholder="https://linkedin.com/in/…"
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="status">Status</Label>
          <select
            id="status"
            className="flex h-9 w-full rounded-lg border border-input bg-transparent px-3 text-sm"
            value={form.status}
            onChange={(e) =>
              set("status", e.target.value as RecruiterLinkStatus)
            }
          >
            {STATUSES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="rating">Your rating (1–5)</Label>
          <Input
            id="rating"
            type="number"
            min={1}
            max={5}
            value={form.personalRating}
            onChange={(e) => set("personalRating", e.target.value)}
          />
        </div>
        <div className="space-y-1.5 sm:col-span-2">
          <Label htmlFor="notes">Private notes</Label>
          <Textarea
            id="notes"
            value={form.notes}
            onChange={(e) => set("notes", e.target.value)}
            rows={3}
            placeholder="Where you met, roles they place, etc."
          />
        </div>
      </div>
      <Button type="submit" disabled={pending}>
        {pending ? "Saving…" : recruiterId ? "Log interaction" : "Add recruiter"}
      </Button>
    </form>
  );
}
