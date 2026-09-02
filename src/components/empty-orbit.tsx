import Link from "next/link";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * Shared across every empty state in the app (dashboard, contacts, chat,
 * knowledge, graph). Google is the primary CTA everywhere — see
 * `.superpowers/sdd/2026-09-02-first-run-accessibility/`. Index order also
 * encodes button styling: primary, outline, ghost.
 */
export const EMPTY_ORBIT_ACTIONS = [
  { href: "/imports", label: "Import from Google", primary: true },
  { href: "/capture", label: "Paste notes" },
  { href: "/contacts/new", label: "Add one person" },
] as const;

const ACTION_VARIANTS = ["default", "outline", "ghost"] as const;

/**
 * No `"use client"` and no hooks on purpose: server components (dashboard,
 * contacts, knowledge) render it directly, and client components (chat,
 * graph) can still import it since it never reaches `@/db`.
 */
export function EmptyOrbit({
  compact,
  hint,
  showSetupLink,
}: {
  compact?: boolean;
  hint?: string;
  showSetupLink?: boolean;
}) {
  return (
    <div
      className={cn(
        "rounded-2xl border border-dashed border-border/70 text-center",
        compact ? "px-4 py-6" : "px-6 py-10"
      )}
    >
      <h2
        className={cn(
          "text-ink",
          compact
            ? "text-lg font-medium"
            : "font-[family-name:var(--font-display)] text-2xl"
        )}
      >
        Your orbit is empty
      </h2>
      <p className="mx-auto mt-2 max-w-md text-sm text-muted-foreground">
        Bring in the people you already know. Orbit remembers them and tells
        you when to reach out.
      </p>
      {hint && (
        <p className="mx-auto mt-1 max-w-md text-sm text-muted-foreground">
          {hint}
        </p>
      )}
      <div className="mt-5 flex flex-wrap items-center justify-center gap-2">
        {EMPTY_ORBIT_ACTIONS.map((action, i) => (
          <Link
            key={action.href}
            href={action.href}
            className={cn(
              buttonVariants({ variant: ACTION_VARIANTS[i] }),
              i === 0 && "bg-primary text-primary-foreground"
            )}
          >
            {action.label}
          </Link>
        ))}
      </div>
      {showSetupLink && (
        <Link
          href="/onboarding/wizard"
          className={cn(buttonVariants({ variant: "ghost" }), "mt-3")}
        >
          Run guided setup
        </Link>
      )}
    </div>
  );
}
