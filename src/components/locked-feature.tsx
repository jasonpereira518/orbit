import Link from "next/link";
import { Lock } from "lucide-react";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * Page-level state for a feature the current plan does not include.
 *
 * Shows what the feature does rather than hiding it, so the paywall reads as an
 * explanation instead of a dead end. This is presentation only — the real boundary is
 * `requireEntitlement` inside the server actions, which holds even against direct POSTs.
 */
export function LockedFeature({
  title,
  description,
  highlights,
  note,
}: {
  title: string;
  description: string;
  highlights: string[];
  note?: string;
}) {
  return (
    <div className="mx-auto max-w-xl space-y-6 rounded-2xl border border-border/70 bg-card p-8 text-center">
      <div className="space-y-3">
        <span className="mx-auto flex size-11 items-center justify-center rounded-full bg-muted">
          <Lock className="size-5 text-muted-foreground" />
        </span>
        <h1 className="font-[family-name:var(--font-display)] text-2xl text-primary">
          {title}
        </h1>
        <p className="text-sm leading-relaxed text-muted-foreground">
          {description}
        </p>
      </div>

      <ul className="mx-auto grid max-w-sm gap-2 text-left">
        {highlights.map((item) => (
          <li
            key={item}
            className="rounded-lg border border-border/60 bg-muted/30 px-3 py-2 text-sm"
          >
            {item}
          </li>
        ))}
      </ul>

      {note && <p className="text-xs text-muted-foreground">{note}</p>}

      <div className="flex flex-wrap items-center justify-center gap-3">
        <Link href="/pricing" className={cn(buttonVariants({ size: "sm" }))}>
          See plans
        </Link>
        <Link
          href="/settings#settings-plan"
          className={cn(buttonVariants({ variant: "outline", size: "sm" }))}
        >
          Your plan
        </Link>
      </div>
    </div>
  );
}
