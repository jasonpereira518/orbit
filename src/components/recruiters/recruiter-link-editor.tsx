"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { setLinkShared, updateMyLink } from "@/actions/recruiters";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { FormField } from "@/components/ui/form-field";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "@/lib/toast";
import type { RecruiterLinkStatus } from "@/db/schema";
import { friendlyError } from "@/lib/errors";

/** Stored link status → the word in the menu. The stored values never change. */
const STATUS_ITEMS: Array<{ value: RecruiterLinkStatus; label: string }> = [
  { value: "planned", label: "Planned" },
  { value: "contacted", label: "Contacted" },
  { value: "active", label: "Active" },
  { value: "archived", label: "Archived" },
];

const NO_RATING = "none";
const RATING_ITEMS = [
  { value: NO_RATING, label: "No rating" },
  ...[1, 2, 3, 4, 5].map((n) => ({ value: String(n), label: `${n} of 5` })),
];

export function RecruiterLinkEditor({
  recruiterId,
  status,
  notes,
  personalRating,
  sharedToPool,
  sharingEnabled,
}: {
  recruiterId: string;
  status: RecruiterLinkStatus;
  notes: string | null;
  personalRating: number | null;
  sharedToPool: boolean;
  /** Global opt-in. When false the per-link control is inert and stays hidden. */
  sharingEnabled: boolean;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [shared, setShared] = useState(sharedToPool);
  const [form, setForm] = useState({
    status,
    notes: notes || "",
    personalRating: personalRating ? String(personalRating) : "",
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle as="h2">Your relationship</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-2">
          <FormField label="Status" id="link-status">
            <Select
              value={form.status}
              onValueChange={(v) =>
                setForm((f) => ({ ...f, status: (v ?? "planned") as RecruiterLinkStatus }))
              }
              items={STATUS_ITEMS}
            >
              <SelectTrigger id="link-status" className="w-full">
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
          <FormField label="Your rating" id="link-rating">
            <Select
              value={form.personalRating || NO_RATING}
              onValueChange={(v) =>
                setForm((f) => ({ ...f, personalRating: !v || v === NO_RATING ? "" : String(v) }))
              }
              items={RATING_ITEMS}
            >
              <SelectTrigger id="link-rating" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {RATING_ITEMS.map((r) => (
                  <SelectItem key={r.value} value={r.value}>
                    {r.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </FormField>
          <FormField label="Private notes" id="link-notes" className="sm:col-span-2">
            <Textarea
              id="link-notes"
              rows={3}
              value={form.notes}
              onChange={(e) =>
                setForm((f) => ({ ...f, notes: e.target.value }))
              }
            />
          </FormField>
        </div>
        {sharingEnabled && (
          <label className="flex items-start gap-3 rounded-lg border border-border-subtle bg-surface-inset p-4 text-sm">
            <Checkbox
              checked={!shared}
              disabled={pending}
              onCheckedChange={(v) => {
                const next = !Boolean(v);
                const previous = shared;
                setShared(next);
                start(async () => {
                  try {
                    await setLinkShared(recruiterId, next);
                    toast.success(
                      next
                        ? "Shared with the pool"
                        : "Kept out of the pool"
                    );
                    router.refresh();
                  } catch (err) {
                    setShared(previous);
                    toast.error(
                      friendlyError(err, "That didn’t update — try again?")
                    );
                  }
                });
              }}
            />
            <span>
              <span className="font-medium text-foreground">
                Keep this recruiter out of the shared pool
              </span>
              <span className="mt-1 block text-muted-foreground">
                Your list is shared, but this one stays visible only to you — along
                with your rating of them.
              </span>
            </span>
          </label>
        )}

        <div className="flex justify-end">
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
                  toast.success("Recruiter updated");
                  router.refresh();
                } catch (err) {
                  toast.error(
                    friendlyError(err, "That didn’t update — try again?")
                  );
                }
              })
            }
          >
            {pending ? "Saving…" : "Save"}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
