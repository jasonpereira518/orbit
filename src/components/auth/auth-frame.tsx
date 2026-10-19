import type { ReactNode } from "react";
import { ArrowLeft } from "lucide-react";
import { OrbitLogo } from "@/components/orbit-logo";
import { buttonVariants } from "@/components/ui/button";
import { IntentLink } from "@/components/ui/intent-link";

/**
 * The column around Clerk's sign-in and sign-up cards: the Orbit mark and wordmark above,
 * the card, and a way back to the landing page below. Clerk's card used to stand alone on
 * a blank page with no mark and no way out but the browser's Back.
 */
export function AuthFrame({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-6 bg-background px-4 py-10">
      <div className="flex items-center gap-2.5">
        <OrbitLogo size="md" priority />
        <span className="font-heading text-2xl leading-none tracking-tight text-ink">Orbit</span>
      </div>
      {children}
      <IntentLink href="/" className={buttonVariants({ variant: "ghost", size: "sm" })}>
        <ArrowLeft className="size-3.5" aria-hidden />
        Back to home
      </IntentLink>
    </div>
  );
}
