import { SignUp } from "@clerk/nextjs";
import { isClerkConfigured, redirectIfAuthenticated } from "@/lib/auth";
import { clerkAppearance } from "@/lib/clerk-appearance";
import { OrbitLogo } from "@/components/orbit-logo";

/**
 * Destinations a `redirect_url` query param may point at after sign-up. A whitelist, not
 * a same-origin check: the value rides in a URL anyone can craft, so only paths where
 * skipping onboarding is deliberate belong here. Pricing qualifies — a visitor who signs
 * up mid-purchase should land back in front of the checkout button, not in onboarding.
 */
const SIGN_UP_REDIRECT_WHITELIST = new Set(["/pricing"]);

export default async function SignUpPage({
  searchParams,
}: {
  searchParams: Promise<{ redirect_url?: string }>;
}) {
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

  const { redirect_url: requested } = await searchParams;
  const redirectUrl =
    requested && SIGN_UP_REDIRECT_WHITELIST.has(requested)
      ? requested
      : "/onboarding";

  return (
    <div className="flex min-h-screen items-center justify-center bg-background">
      <SignUp
        appearance={clerkAppearance}
        forceRedirectUrl={redirectUrl}
        signInForceRedirectUrl="/dashboard"
      />
    </div>
  );
}
