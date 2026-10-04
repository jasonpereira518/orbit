/**
 * The key caps in the intro line. Flat on purpose: one quiet fill, no border, no gradient and
 * no shadow, so they read as part of the sentence rather than as raised keys. Theme tokens
 * only, so dark mode follows without a second set.
 */
const KBD =
  "mx-0.5 inline-flex items-center rounded-md bg-muted px-1.5 py-[3px] align-baseline font-sans text-[11px] font-medium leading-none text-ink/75";

/**
 * Static dashboard header, rendered by BOTH page.tsx and loading.tsx so
 * client navigation shows identical pixels before and after data arrives.
 */
export function DashboardHeader() {
  return (
    <header className="reveal-mount space-y-2">
      <p className="text-sm font-medium text-ink">Your network</p>
      <h1 className="font-[family-name:var(--font-display)] text-4xl tracking-tight text-ink">
        Stay in orbit
      </h1>
      <p className="max-w-xl text-muted-foreground">
        Follow-ups, dormant connections, and people worth reaching out to — in one place.
        {/* A keyboard shortcut is unusable on a touch device that has no keyboard,
            where it also costs a line of a three-line paragraph. Gated on hover
            capability rather than viewport width: a narrow window on a laptop
            still has a ⌘K, and a large tablet still does not. */}
        <span className="hidden [@media(hover:hover)]:inline">
          {" "}
          Press{" "}
          <kbd className={KBD}>
            ⌘K
          </kbd>{" "}
          to jump anywhere, or{" "}
          <kbd className={KBD}>
            ⌘J
          </kbd>{" "}
          to ask your network.
        </span>
      </p>
    </header>
  );
}
