"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { addStartupExpenseAction, setCashSnapshotAction } from "@/actions/admin-yc";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export function LogExpenseForm() {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [category, setCategory] = useState("");
  const [amountUsd, setAmountUsd] = useState("");
  const [note, setNote] = useState("");

  function submit() {
    const amount = Number(amountUsd);
    if (!category.trim() || !Number.isFinite(amount) || amount <= 0) return;
    start(async () => {
      await addStartupExpenseAction({
        category: category.trim(),
        amountUsd: amount,
        incurredAt: new Date().toISOString(),
        note: note.trim() || undefined,
      });
      setCategory("");
      setAmountUsd("");
      setNote("");
      router.refresh();
    });
  }

  return (
    <div className="flex flex-wrap items-end gap-2">
      <div className="space-y-1.5">
        <Label htmlFor="expense-category">Category</Label>
        <Input
          id="expense-category"
          value={category}
          onChange={(e) => setCategory(e.target.value)}
          placeholder="Hosting"
          className="w-32"
        />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="expense-amount">Amount (USD)</Label>
        <Input
          id="expense-amount"
          type="number"
          value={amountUsd}
          onChange={(e) => setAmountUsd(e.target.value)}
          placeholder="49.99"
          className="w-28"
        />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="expense-note">Note</Label>
        <Input
          id="expense-note"
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="optional"
          className="w-40"
        />
      </div>
      <Button type="button" size="sm" disabled={pending} onClick={submit}>
        Log expense
      </Button>
    </div>
  );
}

export function UpdateCashForm() {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [balanceUsd, setBalanceUsd] = useState("");

  function submit() {
    const balance = Number(balanceUsd);
    if (!Number.isFinite(balance) || balance < 0) return;
    start(async () => {
      await setCashSnapshotAction({ balanceUsd: balance, asOf: new Date().toISOString() });
      setBalanceUsd("");
      router.refresh();
    });
  }

  return (
    <div className="flex flex-wrap items-end gap-2">
      <div className="space-y-1.5">
        <Label htmlFor="cash-balance">Current cash on hand (USD)</Label>
        <Input
          id="cash-balance"
          type="number"
          value={balanceUsd}
          onChange={(e) => setBalanceUsd(e.target.value)}
          placeholder="10000"
          className="w-36"
        />
      </div>
      <Button type="button" size="sm" disabled={pending} onClick={submit}>
        Update cash
      </Button>
    </div>
  );
}
