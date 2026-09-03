"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { addOneOffCostAction, setInfraCostAction } from "@/actions/admin-money";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";

/**
 * The one place costs get entered.
 *
 * The recurring/one-off switch is not cosmetic — it picks the destination table, and the
 * two behave differently on purpose. A restated monthly bill must REPLACE the earlier
 * figure (upsert per provider per month); a second one-off expense in the same category
 * and month must be ADDED (append). Collapsing them would either double bills or hide
 * expenses, so the form asks rather than guessing.
 */

const PROVIDERS = [
  "vercel",
  "neon",
  "blob",
  "clerk",
  "resend",
  "twilio",
  "apollo",
  "domain",
];

function thisMonthValue() {
  const now = new Date();
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
}

export function CostEntryForm() {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [mode, setMode] = useState<"recurring" | "oneoff">("recurring");
  const [provider, setProvider] = useState("vercel");
  const [category, setCategory] = useState("");
  const [month, setMonth] = useState(thisMonthValue());
  const [amountUsd, setAmountUsd] = useState("");
  const [note, setNote] = useState("");

  const amount = Number(amountUsd);
  const valid =
    Number.isFinite(amount) &&
    amount > 0 &&
    (mode === "recurring" ? provider.trim().length > 0 : category.trim().length > 0);

  function submit() {
    if (!valid) return;
    start(async () => {
      if (mode === "recurring") {
        await setInfraCostAction({
          provider: provider.trim(),
          // `-01` so the month parses as its first instant in UTC, which is how
          // `monthStart` keys the row.
          month: `${month}-01T00:00:00.000Z`,
          amountUsd: amount,
          note: note.trim() || undefined,
        });
      } else {
        await addOneOffCostAction({
          category: category.trim(),
          amountUsd: amount,
          incurredAt: new Date(`${month}-01T00:00:00.000Z`).toISOString(),
          note: note.trim() || undefined,
        });
      }
      setAmountUsd("");
      setNote("");
      router.refresh();
    });
  }

  return (
    <div className="space-y-3">
      <div
        className="flex w-fit items-center gap-1 rounded-lg border border-border/70 p-0.5"
        role="group"
        aria-label="Cost type"
      >
        {(
          [
            ["recurring", "Monthly bill"],
            ["oneoff", "One-off"],
          ] as const
        ).map(([value, label]) => (
          <button
            key={value}
            type="button"
            onClick={() => setMode(value)}
            aria-pressed={mode === value}
            className={cn(
              "rounded-md px-2.5 py-1 text-xs transition-colors",
              mode === value
                ? "bg-primary/10 text-foreground"
                : "text-muted-foreground hover:text-foreground"
            )}
          >
            {label}
          </button>
        ))}
      </div>

      <div className="flex flex-wrap items-end gap-2">
        {mode === "recurring" ? (
          <div>
            <Label htmlFor="cost-provider">Provider</Label>
            <Input
              id="cost-provider"
              list="cost-providers"
              value={provider}
              onChange={(e) => setProvider(e.target.value)}
              className="w-32"
            />
            <datalist id="cost-providers">
              {PROVIDERS.map((p) => (
                <option key={p} value={p} />
              ))}
            </datalist>
          </div>
        ) : (
          <div>
            <Label htmlFor="cost-category">Category</Label>
            <Input
              id="cost-category"
              value={category}
              onChange={(e) => setCategory(e.target.value)}
              placeholder="Incorporation"
              className="w-36"
            />
          </div>
        )}

        <div>
          <Label htmlFor="cost-month">Month</Label>
          <Input
            id="cost-month"
            type="month"
            value={month}
            onChange={(e) => setMonth(e.target.value)}
            className="w-36"
          />
        </div>

        <div>
          <Label htmlFor="cost-amount">Amount (USD)</Label>
          <Input
            id="cost-amount"
            type="number"
            step="0.01"
            value={amountUsd}
            onChange={(e) => setAmountUsd(e.target.value)}
            placeholder="20.00"
            className="w-28"
          />
        </div>

        <div className="min-w-40 flex-1">
          <Label htmlFor="cost-note">Note</Label>
          <Input
            id="cost-note"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="optional"
          />
        </div>

        <Button onClick={submit} disabled={!valid || pending}>
          {pending ? "Saving…" : "Record"}
        </Button>
      </div>

      <p className="text-xs text-muted-foreground">
        {mode === "recurring"
          ? "Replaces any existing figure for that provider and month, so a restated bill corrects rather than doubles."
          : "Appended. Two one-off costs in the same month are two costs, not a correction."}
      </p>
    </div>
  );
}
