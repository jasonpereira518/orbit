import Link from "next/link";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export default function NotFound() {
  return (
    <div className="mx-auto flex min-h-[60vh] max-w-lg flex-col items-center justify-center gap-4 px-6 py-16 text-center">
      <p className="text-sm font-medium text-ink">404</p>
      <h1 className="font-[family-name:var(--font-display)] text-3xl tracking-tight text-ink">
        Page not found
      </h1>
      <p className="text-muted-foreground">
        That route doesn’t exist — or the link may be out of date.
      </p>
      {/* One way out, to `/`, and deliberately not "Go to dashboard": the root not-found
          is rendered into EVERY page's payload as its boundary fallback, the waitlist's
          included, so an app path named here ships in the waitlist's HTML. From `/` a
          signed-in user is one click from the app (in stealth mode, `/` IS the way in).
          See lib/waitlist-host.ts. */}
      <div className="mt-2 flex flex-wrap items-center justify-center gap-2">
        <Link href="/" className={cn(buttonVariants())}>
          Back to home
        </Link>
      </div>
    </div>
  );
}
