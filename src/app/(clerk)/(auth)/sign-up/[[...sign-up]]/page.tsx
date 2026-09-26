import { SignUp } from "@clerk/nextjs";
import { auth, currentUser } from "@clerk/nextjs/server";
import { isClerkConfigured, redirectIfAuthenticated } from "@/lib/auth";
import { InviteSignedInNotice } from "@/components/auth/invite-signed-in-notice";
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
  searchParams: Promise<{ redirect_url?: string; __clerk_ticket?: string }>;
}) {
  const params = await searchParams;

  // An admin's invitation link (`?__clerk_ticket=`) opened while signed in: offer to sign
  // out and accept it, rather than `redirectIfAuthenticated` carrying the visitor into the
  // account they already have and quietly wasting the invitation.
  if (params.__clerk_ticket && isClerkConfigured()) {
    const { userId } = await auth().catch(() => ({ userId: null }));
    if (userId) {
      const user = await currentUser().catch(() => null);
      return <InviteSignedInNotice email={user?.primaryEmailAddress?.emailAddress ?? null} />;
    }
  }

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

  const { redirect_url: requested } = params;
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
