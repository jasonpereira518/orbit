/**
 * Static reminders header, rendered by BOTH page.tsx and loading.tsx so
 * client navigation shows identical pixels before and after data arrives.
 *
 * `md:pe-[var(--orbit-top-rail)]` keeps the calendar link clear of the fixed
 * notifications/feedback buttons, which are pinned to the viewport's top-right and so sit
 * over anything a page puts at its own right edge. See the variable's comment in
 * globals.css.
 */
import Link from "next/link";

export function RemindersHeader() {
  return (
    <div className="reveal-mount flex flex-wrap items-start justify-between gap-2 md:pe-[var(--orbit-top-rail)]">
      <div>
        <h1 className="font-[family-name:var(--font-display)] text-3xl text-ink">
          Reminders
        </h1>
        <p className="mt-1 text-muted-foreground">
          Create, organize into lists, and take quick actions based on what each
          reminder means.
        </p>
      </div>
      {/* Plain link only — this component is shared with loading.tsx and must not fetch. */}
      <Link
        href="/settings"
        className="text-sm text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
      >
        Subscribe in your calendar →
      </Link>
    </div>
  );
}
