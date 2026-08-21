import Link from "next/link";
import { cn } from "@/lib/utils";

/**
 * Shows how much of a capped plan's contact allowance is used, and turns into an upgrade
 * prompt as it fills. Renders nothing on an uncapped plan.
 *
 * Deliberately understated until it matters: a user at 12 of 100 does not need to be sold
 * anything, so this stays a quiet line until the last quarter of the allowance.
 */
export function ContactQuotaNotice({
  used,
  limit,
}: {
  used: number;
  limit: number | null;
}) {
  if (limit === null) return null;

  const remaining = Math.max(0, limit - used);
  const atLimit = remaining === 0;
  const nearLimit = remaining <= Math.ceil(limit * 0.25);

  if (!nearLimit) {
    return (
      <p className="text-sm text-muted-foreground">
        <span className="tabular-nums">
          {used} of {limit}
        </span>{" "}
        contacts on the free plan.
      </p>
    );
  }

  return (
    <div
      className={cn(
        "flex flex-wrap items-center justify-between gap-3 rounded-xl border p-3",
        atLimit
          ? "border-primary/50 bg-primary/5"
          : "border-border/70 bg-muted/40"
      )}
    >
      <p className="text-sm">
        {atLimit ? (
          <>
            <span className="font-medium text-primary">
              You&apos;ve reached {limit} contacts.
            </span>{" "}
            <span className="text-muted-foreground">
              Everything here stays exactly as it is — you just can&apos;t add
              anyone new until you upgrade.
            </span>
          </>
        ) : (
          <span className="text-muted-foreground">
            <span className="tabular-nums text-foreground">{remaining}</span>{" "}
            {remaining === 1 ? "contact" : "contacts"} left on the free plan.
          </span>
        )}
      </p>
      <Link
        href="/pricing"
        className="shrink-0 text-sm font-medium text-primary underline underline-offset-4 hover:opacity-80"
      >
        See plans
      </Link>
    </div>
  );
}
