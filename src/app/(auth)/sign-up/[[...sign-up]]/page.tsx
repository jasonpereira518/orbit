import { SignUp } from "@clerk/nextjs";
import Link from "next/link";
import {
  isClerkConfigured,
  isDemoMode,
  redirectIfAuthenticated,
} from "@/lib/auth";
import { clerkAppearance } from "@/lib/clerk-appearance";
import { OrbitLogo } from "@/components/orbit-logo";

export default async function SignUpPage() {
  if (!isClerkConfigured()) {
    if (!isDemoMode()) {
      return (
        <div className="flex min-h-screen flex-col items-center justify-center gap-4 bg-background p-6">
          <OrbitLogo size="lg" />
          <h1 className="font-[family-name:var(--font-display)] text-3xl text-primary">
            Orbit
          </h1>
          <p className="max-w-md text-center text-muted-foreground">
            Authentication is not configured for this environment.
          </p>
        </div>
      );
    }

    return (
      <div className="flex min-h-screen flex-col items-center justify-center gap-4 bg-background p-6">
        <OrbitLogo size="lg" />
        <h1 className="font-[family-name:var(--font-display)] text-3xl text-primary">
          Orbit
        </h1>
        <p className="max-w-md text-center text-muted-foreground">
          Clerk is not configured. Running in demo mode.
        </p>
        <Link
          href="/dashboard"
          className="rounded-lg bg-primary px-4 py-2 text-sm text-primary-foreground"
        >
          Open dashboard
        </Link>
      </div>
    );
  }

  await redirectIfAuthenticated();

  return (
    <div className="flex min-h-screen items-center justify-center bg-background">
      <SignUp
        appearance={clerkAppearance}
        forceRedirectUrl="/onboarding"
        signInForceRedirectUrl="/dashboard"
      />
    </div>
  );
}
