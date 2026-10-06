"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { acceptTerms } from "@/actions/onboarding";
import { buttonVariants } from "@/components/ui/button";
import { friendlyError } from "@/lib/errors";
import { TERMS_NOTICE_COPY } from "@/lib/legal";
import { cn } from "@/lib/utils";

/**
 * Sits at the top of every app page until the current Terms are accepted. Not a modal: it
 * never blocks someone from reaching their own data, and it cannot be dismissed without
 * accepting, so the record it produces is an explicit click on a named version.
 */
export function TermsUpdateNotice() {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);

  return (
    <section
      aria-labelledby="terms-update-title"
      className="mb-6 flex flex-col gap-3 rounded-2xl border bg-card p-4 sm:flex-row sm:items-center sm:justify-between"
    >
      <div className="space-y-1">
        <h2 id="terms-update-title" className="text-sm font-medium text-ink">
          {TERMS_NOTICE_COPY.title}
        </h2>
        <p className="text-sm text-muted-foreground">
          {TERMS_NOTICE_COPY.body}:{" "}
          <Link href="/terms" className="underline underline-offset-2">Terms</Link>
          {" · "}
          <Link href="/privacy" className="underline underline-offset-2">Privacy Policy</Link>
        </p>
        {error && (
          <p role="alert" className="text-xs text-destructive">
            {error}
          </p>
        )}
      </div>
      <button
        type="button"
        disabled={pending}
        className={cn(buttonVariants({ size: "sm" }), "shrink-0")}
        onClick={() => {
          setError(null);
          start(async () => {
            try {
              await acceptTerms();
              router.refresh();
            } catch (err) {
              setError(friendlyError(err, TERMS_NOTICE_COPY.retry));
            }
          });
        }}
      >
        {TERMS_NOTICE_COPY.accept}
      </button>
    </section>
  );
}
