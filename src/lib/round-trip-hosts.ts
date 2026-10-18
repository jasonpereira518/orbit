/**
 * Referrers that are Orbit talking to itself, or a provider sending the visitor BACK.
 *
 * ONE DEFINITION, TWO READERS. The page-view beacon route (`/api/p/v`) and the first-touch
 * capture in `src/proxy.ts` both decide "is this an outside channel?" and used to answer it
 * separately: the beacon had this filter, the proxy only dropped the exact request host. So an
 * OAuth callback (`accounts.google.com` → Orbit) could become a signup's first-touch referrer
 * even though the beacon would have discarded the same hop. Both import from here now.
 *
 * Pure: no database, no framework — it is reached from the proxy bundle.
 */
import { getAppBaseUrl } from "@/lib/app-url";
import { waitlistHost } from "@/lib/waitlist-host";

/**
 * Hosts that only ever send a visitor BACK to Orbit, never to it for the first time: the
 * sign-in providers, Stripe's hosted pages, Clerk's account portal. Each round trip starts a
 * new document, whose `document.referrer` is the provider — so without this, "Top referrers"
 * was led by accounts.google.com and checkout.stripe.com, which is Orbit referring itself.
 */
export const ROUND_TRIP_HOSTS: ReadonlySet<string> = new Set([
  "accounts.google.com",
  "login.microsoftonline.com",
  "login.live.com",
  "appleid.apple.com",
  "checkout.stripe.com",
  "billing.stripe.com",
  "js.stripe.com",
]);

/** A Host header (or bare host) reduced to the form `referrerHost()` produces: no port, no `www.`. */
export function bareHost(host: string | null | undefined): string | null {
  if (!host) return null;
  return host.split(",")[0]!.trim().split(":")[0]!.replace(/^www\./, "").toLowerCase() || null;
}

/** The host a Clerk publishable key encodes (`pk_live_<base64("clerk.example.com$")>`). */
export function clerkFrontendHost(key = process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY ?? ""): string | null {
  const encoded = key.split("_")[2];
  if (!encoded) return null;
  try {
    // `atob`, not `Buffer`: this file is reached from the proxy, which may run on the edge.
    return bareHost(atob(encoded).replace(/\$$/, ""));
  } catch {
    return null;
  }
}

/**
 * Whether `referrer` (a host, as `attributionFromUrl` produces, or a URL) is not an outside
 * channel: the request's own host, the app, the waitlist, Clerk's frontend or its account
 * portal, or a provider on {@link ROUND_TRIP_HOSTS}.
 */
export function isOwnOrRoundTrip(referrer: string, requestHost: string | null): boolean {
  const host = bareHost(referrer.replace(/^[a-z]+:\/\//i, "").split("/")[0]);
  if (!host) return false;
  if (host === requestHost) return true;
  // The app and the waitlist are one product on two domains; moving between them is not
  // a referral from outside.
  const ownHosts = [
    bareHost(getAppBaseUrl().replace(/^https?:\/\//, "")),
    bareHost(waitlistHost()),
    clerkFrontendHost(),
  ];
  if (ownHosts.includes(host)) return true;
  if (ROUND_TRIP_HOSTS.has(host)) return true;
  // Clerk's hosted account portal lives on accounts.<your domain>.
  return ownHosts.some((own) => own && host === `accounts.${own}`);
}
