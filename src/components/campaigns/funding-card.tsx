"use client";

import Link from "next/link";
import { useId, useState } from "react";
import { Coins, KeyRound } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { ResearchKeyStatus } from "@/lib/outreach/keys";
import type { OutreachFundingSource } from "@/lib/outreach/types";
import { cn } from "@/lib/utils";

export type Credits = { total: number; monthlyAvailable: number; lifetimeAvailable: number; periodEnd: string };

export function FundingCard({
  credits,
  keys,
  funding,
  onFundingChange,
  busy,
  hasRun,
  onStart,
}: {
  credits: Credits;
  keys: ResearchKeyStatus;
  funding: OutreachFundingSource;
  onFundingChange: (funding: OutreachFundingSource) => void;
  busy: boolean;
  hasRun: boolean;
  onStart: (funding: OutreachFundingSource, researchBudget: number) => void;
}) {
  const [budget, setBudget] = useState(25);
  const headingId = useId();
  const budgetId = useId();
  const orbitDisabled = !keys.orbitSearchAvailable;
  const personalDisabled = !keys.brave.saved;
  const canStart = funding === "orbit" ? !orbitDisabled : !personalDisabled;
  const refreshes = new Date(credits.periodEnd).toLocaleDateString("en-US", { month: "short", day: "numeric" });
  const credited = funding === "orbit" ? Math.min(budget, credits.total) : 0;

  const option = (value: OutreachFundingSource, disabled: boolean, title: string, detail: string, Icon: typeof Coins) => (
    <label
      className={cn(
        "flex items-start gap-3 rounded-xl border p-4 transition-colors has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-ring",
        disabled ? "cursor-not-allowed opacity-60" : "cursor-pointer",
        funding === value ? "border-primary bg-primary/5" : "border-border/70 hover:border-primary/40"
      )}
    >
      <input
        type="radio"
        name="funding"
        value={value}
        checked={funding === value}
        disabled={disabled}
        onChange={() => onFundingChange(value)}
        className="sr-only"
      />
      <Icon className="mt-0.5 size-4 text-primary" aria-hidden />
      <span>
        <span className="block text-sm font-medium text-ink">{title}</span>
        <span className="block text-xs text-muted-foreground">{detail}</span>
      </span>
    </label>
  );

  return (
    <section aria-labelledby={headingId} className="space-y-4 rounded-2xl border border-border/70 bg-card p-5">
      <h2 id={headingId} className="text-lg font-medium text-ink">
        {hasRun ? "Search again" : "Find people"}
      </h2>
      <fieldset className="grid gap-3 sm:grid-cols-2">
        <legend className="sr-only">Pay for research with</legend>
        {option(
          "orbit",
          orbitDisabled,
          `Orbit allowance · ${credits.total} credits left`,
          orbitDisabled ? "Not available right now" : `Refreshes ${refreshes}`,
          Coins
        )}
        {option(
          "personal",
          personalDisabled,
          "Your Brave and Apollo keys",
          personalDisabled
            ? "Add a Brave key in Settings first"
            : keys.apollo.saved
              ? "Billed to your own accounts"
              : "No Apollo key, so people are found but not researched",
          KeyRound
        )}
      </fieldset>
      <div className="flex flex-wrap items-end gap-3">
        <div className="space-y-1.5">
          <Label htmlFor={budgetId}>Research up to</Label>
          <div className="flex items-center gap-2">
            <Input
              id={budgetId}
              type="number"
              min={0}
              max={100}
              value={budget}
              onChange={(e) => setBudget(Math.max(0, Math.min(100, Number(e.target.value) || 0)))}
              className="w-20"
            />
            <span className="text-sm text-muted-foreground">
              people{funding === "orbit" ? ` · ${credited} ${credited === 1 ? "credit" : "credits"}` : ""}
            </span>
          </div>
        </div>
        <Button onClick={() => onStart(funding, budget)} disabled={busy || !canStart}>
          {hasRun ? "Search again" : "Find people"}
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        Searching is free (up to 5 Orbit-funded searches a day). Researching a person uses one credit, and unused credits come
        back when the search ends.{" "}
        {personalDisabled && (
          <Link href="/settings?integration=outreach" className="text-primary hover:underline">
            Add your keys
          </Link>
        )}
      </p>
    </section>
  );
}
