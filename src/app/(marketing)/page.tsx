import { auth } from "@clerk/nextjs/server";
import { LandingHero } from "@/components/landing/landing-hero";
import { isClerkConfigured, isDemoMode } from "@/lib/auth";

export default async function MarketingPage() {
  const clerkOn = isClerkConfigured();
  // clerkMiddleware runs on "/", so auth state is known at first paint —
  // the auth controls render the correct variant with no post-load swap.
  const { userId } = clerkOn ? await auth() : { userId: null };

  return (
    <LandingHero
      clerkOn={clerkOn}
      demoMode={isDemoMode()}
      signedIn={Boolean(userId)}
    />
  );
}
