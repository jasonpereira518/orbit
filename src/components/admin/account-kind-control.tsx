"use client";

import { useState } from "react";
import { setAccountKindAction } from "@/actions/admin";
import { ConfirmActionDialog } from "@/components/admin/confirm-action-dialog";
import { cn } from "@/lib/utils";

type Kind = "internal" | "tester" | "customer";

const OPTIONS: Array<{ value: Kind; label: string; hint: string }> = [
  { value: "customer", label: "Customer", hint: "A real user. Counted everywhere." },
  { value: "tester", label: "Tester", hint: "Asked to try Orbit, not to use it. Left out of product and revenue numbers." },
  { value: "internal", label: "Internal", hint: "The operator, a teammate or the showcase account. Left out of product and revenue numbers." },
];

const LABEL: Record<Kind, string> = { customer: "Customer", tester: "Tester", internal: "Internal" };

/**
 * The account-kind row on an account's Identity panel: what it is now, and a confirmed,
 * reasoned change. Everything the dashboards leave out of their numbers hangs off this one
 * value, which is why the change goes through `ConfirmActionDialog` (a reason is required and
 * the server writes an audit row) rather than a bare select.
 */
export function AccountKindControl({
  targetUserId,
  current,
}: {
  targetUserId: string;
  current: "internal" | "tester" | null;
}) {
  const now: Kind = current ?? "customer";
  const [choice, setChoice] = useState<Kind>(now);

  return (
    <div className="flex flex-wrap items-center gap-3">
      <span
        className={cn(
          "rounded-md px-1.5 py-0.5 text-xs",
          now === "customer" ? "text-muted-foreground" : "bg-primary/10 text-primary"
        )}
      >
        {LABEL[now]}
      </span>
      {/* Keyed on the stored value so the refresh after a change remounts the dialog with the new default. */}
      <ConfirmActionDialog
        key={now}
        trigger={
          <button
            type="button"
            className="inline-flex items-center rounded-md border border-border/70 px-2 py-0.5 text-xs text-muted-foreground transition-colors duration-fast hover:text-foreground"
          >
            Change
          </button>
        }
        title="Change account kind"
        description={
          <fieldset className="space-y-2">
            <legend className="mb-1 text-sm text-muted-foreground">
              Internal and tester accounts are left out of every product and revenue aggregate.
            </legend>
            {OPTIONS.map((option) => (
              <label key={option.value} className="flex cursor-pointer items-start gap-2 text-sm">
                <input
                  type="radio"
                  name={`account-kind-${targetUserId}`}
                  value={option.value}
                  checked={choice === option.value}
                  onChange={() => setChoice(option.value)}
                  className="mt-1 accent-[var(--primary)]"
                />
                <span>
                  <span className="font-medium text-ink">{option.label}</span>
                  <span className="block text-xs text-muted-foreground">{option.hint}</span>
                </span>
              </label>
            ))}
          </fieldset>
        }
        confirmLabel="Save"
        onConfirm={(reason) =>
          setAccountKindAction({
            targetUserId,
            kind: choice === "customer" ? null : choice,
            reason,
          })
        }
      />
    </div>
  );
}
