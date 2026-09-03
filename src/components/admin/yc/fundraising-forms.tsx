"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  addFundraisingInvestorAction,
  createFundraisingRoundAction,
} from "@/actions/admin-yc";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export function CreateRoundForm() {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [name, setName] = useState("");
  const [targetUsd, setTargetUsd] = useState("");

  function submit() {
    const target = Number(targetUsd);
    if (!name.trim() || !Number.isFinite(target) || target <= 0) return;
    start(async () => {
      await createFundraisingRoundAction({ name: name.trim(), targetUsd: target });
      setName("");
      setTargetUsd("");
      router.refresh();
    });
  }

  return (
    <div className="flex flex-wrap items-end gap-2">
      <div className="space-y-1.5">
        <Label htmlFor="round-name">Round name</Label>
        <Input
          id="round-name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Pre-seed"
          className="w-32"
        />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="round-target">Target (USD)</Label>
        <Input
          id="round-target"
          type="number"
          value={targetUsd}
          onChange={(e) => setTargetUsd(e.target.value)}
          placeholder="250000"
          className="w-32"
        />
      </div>
      <Button type="button" size="sm" disabled={pending} onClick={submit}>
        Open round
      </Button>
    </div>
  );
}

export function AddInvestorForm({ roundId }: { roundId: string }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [name, setName] = useState("");
  const [amountUsd, setAmountUsd] = useState("");

  function submit() {
    const amount = Number(amountUsd);
    if (!name.trim() || !Number.isFinite(amount) || amount <= 0) return;
    start(async () => {
      await addFundraisingInvestorAction({
        roundId,
        name: name.trim(),
        amountUsd: amount,
        committedAt: new Date().toISOString(),
      });
      setName("");
      setAmountUsd("");
      router.refresh();
    });
  }

  return (
    <div className="flex flex-wrap items-end gap-2">
      <div className="space-y-1.5">
        <Label htmlFor={`investor-name-${roundId}`}>Investor</Label>
        <Input
          id={`investor-name-${roundId}`}
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Jane Doe"
          className="w-32"
        />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor={`investor-amount-${roundId}`}>Amount (USD)</Label>
        <Input
          id={`investor-amount-${roundId}`}
          type="number"
          value={amountUsd}
          onChange={(e) => setAmountUsd(e.target.value)}
          placeholder="25000"
          className="w-28"
        />
      </div>
      <Button type="button" size="sm" disabled={pending} onClick={submit}>
        Add commitment
      </Button>
    </div>
  );
}
