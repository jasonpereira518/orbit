"use client";

import { useState } from "react";
import { useGuardedTransition } from "@/lib/single-flight";
import { useRouter } from "next/navigation";
import { Lock, Sparkles } from "lucide-react";
import { unlockRecruiterContact } from "@/actions/recruiters";
import { Button } from "@/components/ui/button";
import { toast } from "@/lib/toast";
import { friendlyError } from "@/lib/errors";

export function RecruiterUnlockButton({
  recruiterId,
  hasEmail,
  hasLinkedin,
}: {
  recruiterId: string;
  hasEmail?: boolean;
  hasLinkedin?: boolean;
}) {
  const router = useRouter();
  const [pending, start] = useGuardedTransition();
  const [error, setError] = useState<string | null>(null);

  function handleUnlock() {
    setError(null);
    start(async () => {
      try {
        const res = await unlockRecruiterContact(recruiterId);
        if (!res.ok) {
          setError(res.error);
          toast.error(res.error);
          return;
        }
        toast.success("Contact details unlocked!");
        router.refresh();
      } catch (err) {
        const msg = friendlyError(err, "Couldn't unlock contact details — try again?");
        setError(msg);
        toast.error(msg);
      }
    });
  }

  return (
    <div className="space-y-3 rounded-xl border border-border/70 bg-muted/30 p-4">
      <div className="flex items-start gap-3">
        <div className="mt-0.5 rounded-full bg-primary/10 p-2 text-primary">
          <Lock className="h-4 w-4" />
        </div>
        <div className="min-w-0 flex-1 text-sm">
          <p className="font-medium text-ink">Contact details are locked</p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            This recruiter was contributed to the shared pool. Access their direct
            {hasEmail && hasLinkedin
              ? " work email and LinkedIn profile"
              : hasEmail
                ? " work email"
                : " contact details"}{" "}
            for 1 credit.
          </p>
          {error && <p className="mt-2 text-xs font-medium text-destructive">{error}</p>}
        </div>
      </div>
      <div className="flex items-center justify-between border-t border-border/50 pt-3">
        <span className="text-xs text-muted-foreground">Cost: 1 Credit</span>
        <Button
          size="sm"
          disabled={pending}
          onClick={handleUnlock}
          className="bg-primary text-primary-foreground hover:bg-primary/90"
        >
          <Sparkles className="mr-1.5 h-3.5 w-3.5" />
          {pending ? "Unlocking…" : "Unlock Contact (1 Credit)"}
        </Button>
      </div>
    </div>
  );
}
