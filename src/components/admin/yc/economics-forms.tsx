"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { addAcquisitionSpendAction, setEstimatedChurnAction } from "@/actions/admin-yc";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

/** `YYYY-MM` for the current UTC month: the default, and the latest a spend row can be for. */
function thisMonthValue() {
  const now = new Date();
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
}

/**
 * One month of acquisition spend. A row belongs to exactly one calendar month — the month
 * picked here — so logging September twice in September, or September's bill in October,
 * lands in September both times and is never counted in two months.
 */
export function LogAcquisitionSpendForm() {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [channel, setChannel] = useState("");
  const [amountUsd, setAmountUsd] = useState("");
  const [month, setMonth] = useState(thisMonthValue());

  function submit() {
    const amount = Number(amountUsd);
    if (!channel.trim() || !month || !Number.isFinite(amount) || amount <= 0) return;
    start(async () => {
      await addAcquisitionSpendAction({ channel: channel.trim(), amountUsd: amount, month });
      setChannel("");
      setAmountUsd("");
      router.refresh();
    });
  }

  return (
    <div className="flex flex-wrap items-end gap-2">
      <div className="space-y-1.5">
        <Label htmlFor="spend-channel">Channel</Label>
        <Input
          id="spend-channel"
          value={channel}
          onChange={(e) => setChannel(e.target.value)}
          placeholder="Google Ads"
          className="w-36"
        />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="spend-month">Month</Label>
        <Input
          id="spend-month"
          type="month"
          value={month}
          max={thisMonthValue()}
          onChange={(e) => setMonth(e.target.value)}
          className="w-36"
        />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="spend-amount">Amount (USD, that month)</Label>
        <Input
          id="spend-amount"
          type="number"
          value={amountUsd}
          onChange={(e) => setAmountUsd(e.target.value)}
          placeholder="300"
          className="w-32"
        />
      </div>
      <Button type="button" size="sm" disabled={pending} onClick={submit}>
        Log spend
      </Button>
    </div>
  );
}

export function EstimatedChurnForm({ currentPct }: { currentPct: number | null }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [pct, setPct] = useState(currentPct?.toString() ?? "");

  function submit() {
    const value = Number(pct);
    if (!Number.isFinite(value) || value < 0) return;
    start(async () => {
      await setEstimatedChurnAction({ monthlyChurnPct: value });
      router.refresh();
    });
  }

  return (
    <div className="flex flex-wrap items-end gap-2">
      <div className="space-y-1.5">
        <Label htmlFor="churn-pct">Estimated monthly churn (%)</Label>
        <Input
          id="churn-pct"
          type="number"
          value={pct}
          onChange={(e) => setPct(e.target.value)}
          placeholder="2"
          className="w-24"
        />
      </div>
      <Button type="button" size="sm" disabled={pending} onClick={submit}>
        Update estimate
      </Button>
    </div>
  );
}
