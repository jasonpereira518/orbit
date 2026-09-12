import Link from "next/link";
import { EyeOff } from "lucide-react";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * What renders in place of a surface an operator has hidden from everyone.
 *
 * Shares the shape and tone of `LockedFeature` but NOT its purpose, which is why it is a
 * separate component rather than a variant. That one is a paywall: it sells the feature,
 * lists what you would get, and links to pricing. This one has nothing to sell — the
 * feature is not gone for this user, it is gone for everyone, and no action they can take
 * brings it back. So it explains, points home, and stops.
 *
 * A 404 was the alternative. It leaks less, but a surface that was on the user's own
 * sidebar yesterday reads as data loss when it 404s today, and support cost is a real cost.
 */
export function SurfaceUnavailable({ label }: { label?: string }) {
  return (
    <div className="mx-auto max-w-md space-y-5 rounded-2xl border border-border/70 bg-card p-8 text-center">
      <span className="mx-auto flex size-11 items-center justify-center rounded-full border border-border bg-muted/40">
        <EyeOff className="size-5 text-muted-foreground" aria-hidden />
      </span>

      <div className="space-y-2">
        <h1 className="font-[family-name:var(--font-display)] text-2xl text-ink">
          {label ? `${label} isn't available` : "Not available"}
        </h1>
        <p className="text-sm leading-relaxed text-muted-foreground">
          This part of Orbit is switched off right now. Nothing has been deleted — anything
          you saved here is untouched and will be exactly as you left it when it returns.
        </p>
      </div>

      <Link
        href="/dashboard"
        className={cn(buttonVariants({ variant: "outline", size: "sm" }))}
      >
        Back to dashboard
      </Link>
    </div>
  );
}
