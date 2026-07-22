"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { updateMyLink } from "@/actions/recruiters";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "@/lib/toast";
import type { RecruiterLinkStatus } from "@/db/schema";

const STATUSES: RecruiterLinkStatus[] = [
  "planned",
  "contacted",
  "active",
  "archived",
];

export function RecruiterLinkEditor({
  recruiterId,
  status,
  notes,
  personalRating,
}: {
  recruiterId: string;
  status: RecruiterLinkStatus;
  notes: string | null;
  personalRating: number | null;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [form, setForm] = useState({
    status,
    notes: notes || "",
    personalRating: personalRating ? String(personalRating) : "",
  });

  return (
    <div className="space-y-4 rounded-2xl border border-border/70 bg-card p-5">
      <h2 className="font-[family-name:var(--font-display)] text-lg text-primary">
        Your relationship
      </h2>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="link-status">Status</Label>
          <select
            id="link-status"
            className="flex h-9 w-full rounded-lg border border-input bg-transparent px-3 text-sm"
            value={form.status}
            onChange={(e) =>
              setForm((f) => ({
                ...f,
                status: e.target.value as RecruiterLinkStatus,
              }))
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
          <Label htmlFor="link-rating">Your rating</Label>
          <select
            id="link-rating"
            className="flex h-9 w-full rounded-lg border border-input bg-transparent px-3 text-sm"
            value={form.personalRating}
            onChange={(e) =>
              setForm((f) => ({ ...f, personalRating: e.target.value }))
            }
          >
            <option value="">No rating</option>
            {[1, 2, 3, 4, 5].map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </div>
        <div className="space-y-1.5 sm:col-span-2">
          <Label htmlFor="link-notes">Private notes</Label>
          <Textarea
            id="link-notes"
            rows={3}
            value={form.notes}
            onChange={(e) =>
              setForm((f) => ({ ...f, notes: e.target.value }))
            }
          />
        </div>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button
          disabled={pending}
          onClick={() =>
            start(async () => {
              try {
                await updateMyLink(recruiterId, {
                  status: form.status,
                  notes: form.notes,
                  personalRating: form.personalRating
                    ? Number(form.personalRating)
                    : null,
                });
                toast.success("Updated");
                router.refresh();
              } catch (err) {
                toast.error(
                  err instanceof Error ? err.message : "Update failed"
                );
              }
            })
          }
        >
          Save
        </Button>
      </div>
    </div>
  );
}
