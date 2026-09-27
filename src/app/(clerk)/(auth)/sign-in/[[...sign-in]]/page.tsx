import { SignIn } from "@clerk/nextjs";
import { isClerkConfigured, redirectIfAuthenticated } from "@/lib/auth";
import { clerkAppearance } from "@/lib/clerk-appearance";
import { OrbitLogo } from "@/components/orbit-logo";

export default async function SignInPage() {
  // Demo mode never reaches the branch below: `redirectIfAuthenticated` treats it as
  // already signed in and sends the visitor straight into the app. What's left here is
  // the genuine misconfiguration case — Clerk missing outside of demo mode.
  await redirectIfAuthenticated();

  if (!isClerkConfigured()) {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center gap-4 bg-background p-6">
        <OrbitLogo size="lg" />
        <h1 className="font-[family-name:var(--font-display)] text-3xl text-ink">
          Orbit
        </h1>
        <p className="max-w-md text-center text-muted-foreground">
          Authentication is not configured for this environment.
        </p>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-background">
      <SignIn
        appearance={clerkAppearance}
        forceRedirectUrl="/dashboard"
        signUpForceRedirectUrl="/onboarding"
      />
    </div>
  );
}
