import { LandingMotionProvider } from "@/components/landing/landing-motion-provider";

/**
 * Checkout lives in its own route group rather than `(marketing)` because `/upgrade`
 * requires a session — a purchase needs an account to attribute it to. The marketing group
 * is asserted to be publicly reachable by `scripts/smoke-public-routes.ts`, so a protected
 * page there would (correctly) fail that guard.
 *
 * The motion provider is duplicated from the marketing layout for the same reason it exists
 * there: this tree never passes through AppShell, so `motion/react` needs its own
 * `MotionConfig` to honour prefers-reduced-motion.
 */
export default function CheckoutLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return <LandingMotionProvider>{children}</LandingMotionProvider>;
}
