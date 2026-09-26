/**
 * The Clerk instance's PEM public key (Clerk dashboard → API keys → "JWT public key"), for
 * verifying session tokens without a network call.
 *
 * Without it, Clerk verifies against the JWKS it fetches from its Backend API — once per
 * server instance, so the first request on every COLD instance waits on a round trip to
 * Clerk before anything else happens. That lands on the proxy (every page load) and on
 * `/api/track` (every page view's beacon). `@clerk/nextjs` v7 does not read this variable
 * on its own, so each verifier passes it through; unset, verification is unchanged.
 */
export function clerkJwtKey(): string | undefined {
  // A PEM pasted into a one-line env field often arrives with literal `\n` escapes. Clerk
  // strips real line breaks from the key but not those, and would build a corrupt key.
  return process.env.CLERK_JWT_KEY?.replace(/\\n/g, "\n").trim() || undefined;
}
