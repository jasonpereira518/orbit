"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  addFundraisingInvestorAction,
  addNonDilutiveFundingAction,
  createFundraisingRoundAction,
  deleteFundraisingInvestorAction,
  deleteNonDilutiveFundingAction,
  markInvestorReceivedAction,
  recordLoanRepaymentAction,
  setFundraisingRoundStatusAction,
} from "@/actions/admin-yc";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";

/** Today as `YYYY-MM-DD`, which is what `<input type="date">` expects. */
function todayValue() {
  return new Date().toISOString().slice(0, 10);
}

/**
 * A native `<select>` wearing `Input`'s clothes.
 *
 * Deliberately not `components/ui/select` — that is a Base UI popover built for long,
 * searchable lists, and these fields have two and six options. Inside a
 * `flex flex-wrap items-end` row a native control also keeps its baseline aligned with the
 * text inputs beside it, which the popover version does not.
 */
function FieldSelect({
  id,
  value,
  onChange,
  options,
  className,
}: {
  id: string;
  value: string;
  onChange: (value: string) => void;
  options: readonly { value: string; label: string }[];
  className?: string;
}) {
  return (
    <select
      id={id}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className={cn(
        "h-8 rounded-lg border border-input bg-transparent px-2 py-1 text-sm transition-colors outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 dark:bg-input/30",
        className
      )}
    >
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

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
  // Defaults to today but is editable — the previous version hardcoded `new Date()` at
  // submit time, so a commitment made last month could only ever be recorded as today's.
  const [committedAt, setCommittedAt] = useState(todayValue());
  const [receivedAt, setReceivedAt] = useState("");

  function submit() {
    const amount = Number(amountUsd);
    if (!name.trim() || !Number.isFinite(amount) || amount <= 0) return;
    start(async () => {
      await addFundraisingInvestorAction({
        roundId,
        name: name.trim(),
        amountUsd: amount,
        committedAt: new Date(committedAt).toISOString(),
        receivedAt: receivedAt ? new Date(receivedAt).toISOString() : null,
      });
      setName("");
      setAmountUsd("");
      setCommittedAt(todayValue());
      setReceivedAt("");
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
      <div className="space-y-1.5">
        <Label htmlFor={`investor-committed-${roundId}`}>Committed</Label>
        <Input
          id={`investor-committed-${roundId}`}
          type="date"
          value={committedAt}
          onChange={(e) => setCommittedAt(e.target.value)}
          className="w-36"
        />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor={`investor-received-${roundId}`}>Received</Label>
        <Input
          id={`investor-received-${roundId}`}
          type="date"
          value={receivedAt}
          onChange={(e) => setReceivedAt(e.target.value)}
          className="w-36"
        />
      </div>
      <Button type="button" size="sm" disabled={pending} onClick={submit}>
        Add commitment
      </Button>
    </div>
  );
}

/** Close a round, or reopen one closed by mistake. */
export function RoundStatusButton({
  roundId,
  status,
}: {
  roundId: string;
  status: "open" | "closed";
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const next = status === "open" ? "closed" : "open";

  return (
    <Button
      type="button"
      size="sm"
      variant="outline"
      disabled={pending}
      onClick={() =>
        start(async () => {
          await setFundraisingRoundStatusAction({ roundId, status: next });
          router.refresh();
        })
      }
    >
      {status === "open" ? "Close round" : "Reopen"}
    </Button>
  );
}

/** Flip one commitment between "committed" and "in the bank". */
export function MarkReceivedButton({
  investorId,
  received,
}: {
  investorId: string;
  received: boolean;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();

  return (
    <button
      type="button"
      disabled={pending}
      className="rounded px-1.5 py-0.5 text-xs text-muted-foreground transition-colors duration-fast hover:text-foreground disabled:opacity-50"
      onClick={() =>
        start(async () => {
          await markInvestorReceivedAction({
            investorId,
            receivedAt: received ? null : new Date().toISOString(),
          });
          router.refresh();
        })
      }
    >
      {received ? "Undo" : "Mark received"}
    </button>
  );
}

export function DeleteInvestorButton({ investorId }: { investorId: string }) {
  const router = useRouter();
  const [pending, start] = useTransition();

  return (
    <button
      type="button"
      disabled={pending}
      className="rounded px-1.5 py-0.5 text-xs text-muted-foreground transition-colors duration-fast hover:text-destructive disabled:opacity-50"
      onClick={() =>
        start(async () => {
          await deleteFundraisingInvestorAction({ investorId });
          router.refresh();
        })
      }
    >
      Remove
    </button>
  );
}

const KIND_OPTIONS = [
  { value: "grant", label: "Grant" },
  { value: "prize", label: "Prize" },
  { value: "credit", label: "Credits" },
  { value: "accelerator", label: "Accelerator" },
  { value: "loan", label: "Loan / RBF" },
  { value: "other", label: "Other" },
] as const;

const FORM_OPTIONS = [
  { value: "cash", label: "Cash" },
  { value: "in_kind", label: "In-kind" },
] as const;

export function AddNonDilutiveForm() {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [source, setSource] = useState("");
  const [kind, setKind] = useState<string>("grant");
  const [form, setForm] = useState<string>("cash");
  const [amountUsd, setAmountUsd] = useState("");
  const [awardedAt, setAwardedAt] = useState(todayValue());
  const [receivedAt, setReceivedAt] = useState("");
  const [expiresAt, setExpiresAt] = useState("");

  // Loans are the only kind that is repayable by default, but the flag is stored rather
  // than derived so a grant with a clawback clause can be marked repayable too.
  const [repayable, setRepayable] = useState(false);
  function pickKind(next: string) {
    setKind(next);
    setRepayable(next === "loan");
    // Credits are the overwhelmingly common in-kind case; everything else is usually cash.
    setForm(next === "credit" ? "in_kind" : "cash");
  }

  function submit() {
    const amount = Number(amountUsd);
    if (!source.trim() || !Number.isFinite(amount) || amount <= 0) return;
    start(async () => {
      await addNonDilutiveFundingAction({
        source: source.trim(),
        kind,
        form,
        amountUsd: amount,
        awardedAt: new Date(awardedAt).toISOString(),
        receivedAt: receivedAt ? new Date(receivedAt).toISOString() : null,
        expiresAt: expiresAt ? new Date(expiresAt).toISOString() : null,
        repayable,
      });
      setSource("");
      setAmountUsd("");
      setAwardedAt(todayValue());
      setReceivedAt("");
      setExpiresAt("");
      router.refresh();
    });
  }

  return (
    <div className="flex flex-wrap items-end gap-2">
      <div className="space-y-1.5">
        <Label htmlFor="nd-source">Source</Label>
        <Input
          id="nd-source"
          value={source}
          onChange={(e) => setSource(e.target.value)}
          placeholder="AWS Activate"
          className="w-40"
          list="nd-sources"
        />
        <datalist id="nd-sources">
          {["AWS Activate", "Google for Startups", "Azure for Startups", "Anthropic", "OpenAI", "Vercel"].map((s) => (
            <option key={s} value={s} />
          ))}
        </datalist>
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="nd-kind">Kind</Label>
        <FieldSelect id="nd-kind" value={kind} onChange={pickKind} options={KIND_OPTIONS} className="w-32" />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="nd-form">Form</Label>
        <FieldSelect id="nd-form" value={form} onChange={setForm} options={FORM_OPTIONS} className="w-24" />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="nd-amount">Amount (USD)</Label>
        <Input
          id="nd-amount"
          type="number"
          value={amountUsd}
          onChange={(e) => setAmountUsd(e.target.value)}
          placeholder="5000"
          className="w-28"
        />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="nd-awarded">Awarded</Label>
        <Input
          id="nd-awarded"
          type="date"
          value={awardedAt}
          onChange={(e) => setAwardedAt(e.target.value)}
          className="w-36"
        />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="nd-received">Received</Label>
        <Input
          id="nd-received"
          type="date"
          value={receivedAt}
          onChange={(e) => setReceivedAt(e.target.value)}
          className="w-36"
        />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="nd-expires">Expires</Label>
        <Input
          id="nd-expires"
          type="date"
          value={expiresAt}
          onChange={(e) => setExpiresAt(e.target.value)}
          className="w-36"
        />
      </div>
      <label className="flex h-8 items-center gap-1.5 text-xs text-muted-foreground">
        <input
          type="checkbox"
          checked={repayable}
          onChange={(e) => setRepayable(e.target.checked)}
          className="size-3.5 accent-primary"
        />
        Repayable
      </label>
      <Button type="button" size="sm" disabled={pending} onClick={submit}>
        Add funding
      </Button>
    </div>
  );
}

/**
 * Record total repaid against a loan.
 *
 * Absolute rather than incremental, so a double-submit corrects the figure instead of
 * doubling it.
 */
export function RepaymentForm({
  id,
  repaidUsd,
  amountUsd,
}: {
  id: string;
  repaidUsd: number;
  amountUsd: number;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [value, setValue] = useState(String(repaidUsd));

  function submit() {
    const repaid = Number(value);
    if (!Number.isFinite(repaid) || repaid < 0 || repaid > amountUsd) return;
    start(async () => {
      await recordLoanRepaymentAction({ id, repaidUsd: repaid });
      router.refresh();
    });
  }

  return (
    <div className="flex items-center gap-1.5">
      <Input
        type="number"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        aria-label="Total repaid (USD)"
        className="h-7 w-24"
      />
      <Button type="button" size="sm" variant="outline" disabled={pending} onClick={submit}>
        Save
      </Button>
    </div>
  );
}

export function DeleteNonDilutiveButton({ id }: { id: string }) {
  const router = useRouter();
  const [pending, start] = useTransition();

  return (
    <button
      type="button"
      disabled={pending}
      className="rounded px-1.5 py-0.5 text-xs text-muted-foreground transition-colors duration-fast hover:text-destructive disabled:opacity-50"
      onClick={() =>
        start(async () => {
          await deleteNonDilutiveFundingAction({ id });
          router.refresh();
        })
      }
    >
      Remove
    </button>
  );
}
