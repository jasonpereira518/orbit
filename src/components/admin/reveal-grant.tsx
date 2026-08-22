"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Eye, EyeOff, ShieldAlert } from "lucide-react";
import { ConfirmActionDialog } from "@/components/admin/confirm-action-dialog";
import { grantRevealAction, revokeRevealAction } from "@/actions/admin";
import { toast } from "@/lib/toast";

/**
 * The account-wide unmask, and the banner that makes it visible while it is live.
 *
 * The banner is not decoration. Masked is the default everywhere in this console, and the
 * only way to know which mode you are looking at is for the unmasked one to announce
 * itself — its absence is what makes "this is masked" a statement you can trust rather than
 * assume. It shows the reason you typed and counts down to re-masking.
 */
export function RevealAccountButton({
  targetUserId,
  email,
  contactCount,
}: {
  targetUserId: string;
  email: string | null;
  contactCount: number;
}) {
  return (
    <ConfirmActionDialog
      trigger={
        <button
          type="button"
          className="inline-flex items-center gap-1.5 rounded-md border border-border/70 px-2.5 py-1 text-xs text-muted-foreground transition-colors duration-fast hover:text-foreground"
        >
          <Eye className="size-3" aria-hidden />
          Unmask records
        </button>
      }
      title="Unmask this account's records?"
      description={`Shows real names, emails, phone numbers and notes for all ${contactCount} contacts on ${email ?? "this account"}, and the notes on their interactions, for 15 minutes. These are third parties who never signed up for Orbit. Chat transcripts stay unreadable. Your reason is logged against your name.`}
      confirmLabel="Unmask for 15 minutes"
      minReason={8}
      onConfirm={(reason) => grantRevealAction({ targetUserId, reason })}
    />
  );
}

export function RevealBanner({
  targetUserId,
  reason,
  expiresAt,
}: {
  targetUserId: string;
  reason: string;
  /** ISO string: a Date cannot cross the server/client boundary as a prop. */
  expiresAt: string;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [remaining, setRemaining] = useState(() => msLeft(expiresAt));

  useEffect(() => {
    const tick = () => {
      const left = msLeft(expiresAt);
      setRemaining(left);
      // Re-fetch the moment it lapses, so the page re-masks itself rather than showing
      // unmasked data behind an expired banner.
      if (left <= 0) router.refresh();
    };
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [expiresAt, router]);

  const remask = () => {
    startTransition(async () => {
      try {
        await revokeRevealAction({ targetUserId });
        toast.success("Records re-masked.");
        router.refresh();
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "That didn't work.");
      }
    });
  };

  return (
    <div className="sticky top-16 z-20 flex flex-wrap items-center gap-3 rounded-lg border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm">
      <ShieldAlert className="size-4 shrink-0 text-destructive" aria-hidden />
      <span className="font-medium text-destructive">Records unmasked</span>
      <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
        {reason}
      </span>
      <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
        {formatRemaining(remaining)} left
      </span>
      <button
        type="button"
        onClick={remask}
        disabled={pending}
        className="inline-flex shrink-0 items-center gap-1 rounded-md border border-border/70 bg-background px-2 py-1 text-xs transition-colors duration-fast hover:text-primary disabled:opacity-50"
      >
        <EyeOff className="size-3" aria-hidden />
        {pending ? "Re-masking…" : "Re-mask now"}
      </button>
    </div>
  );
}

function msLeft(expiresAt: string): number {
  return Math.max(0, new Date(expiresAt).getTime() - Date.now());
}

function formatRemaining(ms: number): string {
  const total = Math.ceil(ms / 1000);
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}
