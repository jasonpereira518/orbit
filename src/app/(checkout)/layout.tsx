import { auth } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";
import { LandingMotionProvider } from "@/components/landing/landing-motion-provider";
import { isClerkConfigured, isDemoMode } from "@/lib/auth";

/**
 * Checkout lives in its own route group rather than `(marketing)` because `/upgrade`
 * requires a session — a purchase needs an account to attribute it to. The marketing group
 * is asserted to be publicly reachable by `scripts/smoke-public-routes.ts`, so a protected
 * page there would (correctly) fail that guard.
 *
 * It is also outside `(app)`: this surface wears the marketing visual world, not the
 * product shell.
 *
 * `force-dynamic` is required, not stylistic. Without it Next tries to prerender
 * `/upgrade` at build time, where there is no session, and `requireUserId()` throws
 * `UnauthorizedError` — failing the build rather than the request. Same reason
 * `(admin)/layout.tsx` sets it.
 *
 * The redirect below is a UX affordance, not the security boundary: `proxy.ts` already
 * protects the route, but its refusal surfaces as a 404, which is the wrong answer for
 * someone trying to pay. Layouts also do not re-run for Server Action POSTs, so
 * `startLifetimeCheckout()` re-asserts `requireUserId()` independently.
 */
export const dynamic = "force-dynamic";

export default async function CheckoutLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const clerkOn = isClerkConfigured();
  const userId = clerkOn
    ? (await auth()).userId
    : isDemoMode()
      ? "demo-user"
      : null;

  if (clerkOn && !userId) redirect("/sign-in");
  if (!userId) redirect("/");

  return <LandingMotionProvider>{children}</LandingMotionProvider>;
}
