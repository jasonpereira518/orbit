"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { addAcquisitionSpendAction, setEstimatedChurnAction } from "@/actions/admin-yc";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export function LogAcquisitionSpendForm() {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [channel, setChannel] = useState("");
  const [amountUsd, setAmountUsd] = useState("");

  function submit() {
    const amount = Number(amountUsd);
    if (!channel.trim() || !Number.isFinite(amount) || amount <= 0) return;
    const now = new Date();
    const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    start(async () => {
      await addAcquisitionSpendAction({
        channel: channel.trim(),
        amountUsd: amount,
        periodStart: thirtyDaysAgo.toISOString(),
        periodEnd: now.toISOString(),
      });
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
        <Label htmlFor="spend-amount">Amount (USD, this period)</Label>
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
