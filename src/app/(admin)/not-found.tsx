import Link from "next/link";

/**
 * Deliberately generic. This renders both for a genuinely missing account and for a
 * non-operator who found the URL — so it must never mention an admin console, or the 404
 * would leak the very thing it exists to hide.
 */
export default function AdminNotFound() {
  return (
    <div className="flex min-h-dvh flex-col items-center justify-center gap-3 px-6 text-center">
      <h1 className="font-[family-name:var(--font-display)] text-2xl text-ink">
        Page not found
      </h1>
      <p className="text-sm text-muted-foreground">
        That page doesn&apos;t exist.
      </p>
      <Link href="/" className="text-sm text-primary underline underline-offset-4">
        Go home
      </Link>
    </div>
  );
}
