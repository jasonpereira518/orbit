/**
 * The security headers every response carries, built once at config time.
 *
 * Orbit renders user-supplied contact notes and model-written markdown, embeds Clerk, and
 * redirects to Stripe — and sent no security headers at all. Everything below is static
 * except the Content-Security-Policy, which starts REPORT-ONLY: a wrong origin in an
 * enforced policy silently breaks sign-in or checkout for everyone, while a wrong origin
 * in a report-only one is a row in `error_events` (`/api/csp-report`). Flip to enforcing
 * with `CSP_ENFORCE=1` once the reports have stayed quiet for a week.
 *
 * `'unsafe-inline'` in script-src is the honest cost of not threading a nonce through
 * `proxy.ts` and Clerk: Next's hydration scripts and next-themes' bootstrap are inline. A
 * nonce-based policy would force every marketing page dynamic, which Phase 5 just undid.
 *
 * No imports from the app: `next.config.ts` loads this before any alias exists, and
 * `scripts/smoke-security-headers.ts` pins it.
 */

export type SecurityHeader = { key: string; value: string };

/**
 * The Clerk frontend API host encoded in a publishable key (`pk_<env>_` + base64 of
 * `<host>$`). Needed verbatim in script-src/connect-src/frame-src; null if unreadable.
 */
export function clerkFrontendApiHost(publishableKey: string | undefined): string | null {
  if (!publishableKey) return null;
  const m = /^pk_(?:live|test)_([A-Za-z0-9+/=]+)$/.exec(publishableKey.trim());
  if (!m) return null;
  try {
    const host = Buffer.from(m[1], "base64").toString("utf8").replace(/\$$/, "");
    return /^[a-z0-9.-]+$/i.test(host) ? host : null;
  } catch {
    return null;
  }
}

const join = (...sources: Array<string | null | undefined | false>) =>
  sources.filter((s): s is string => Boolean(s)).join(" ");

export function buildSecurityHeaders(options: {
  dev: boolean;
  enforce: boolean;
  clerkPublishableKey: string | undefined;
}): SecurityHeader[] {
  const clerkHost = clerkFrontendApiHost(options.clerkPublishableKey);
  const clerk = clerkHost ? `https://${clerkHost}` : null;

  const directives = [
    `default-src 'self'`,
    `script-src ${join(
      "'self'",
      "'unsafe-inline'",
      options.dev && "'unsafe-eval'",
      clerk,
      "https://*.clerk.accounts.dev",
      "https://challenges.cloudflare.com",
      "https://va.vercel-scripts.com"
    )}`,
    `connect-src ${join(
      "'self'",
      clerk,
      "https://*.clerk.accounts.dev",
      "https://*.ingest.sentry.io",
      "https://*.ingest.us.sentry.io",
      "https://va.vercel-scripts.com",
      "https://vitals.vercel-insights.com"
    )}`,
    // Avatars redirect to Blob, LinkedIn's CDN, unavatar and Clerk; the set is open by design.
    `img-src 'self' data: blob: https:`,
    `style-src 'self' 'unsafe-inline'`,
    `font-src 'self' data:`,
    // Capture records voice and photos in the browser before upload.
    `media-src 'self' blob: data:`,
    `worker-src 'self' blob:`,
    `frame-src ${join("'self'", clerk, "https://*.clerk.accounts.dev", "https://challenges.cloudflare.com")}`,
    `object-src 'none'`,
    `base-uri 'self'`,
    `form-action 'self'`,
    `frame-ancestors 'none'`,
    `report-uri /api/csp-report`,
  ];

  const headers: SecurityHeader[] = [
    { key: "X-Content-Type-Options", value: "nosniff" },
    { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
    { key: "X-Frame-Options", value: "DENY" },
    {
      key: "Permissions-Policy",
      value: "camera=(self), microphone=(self), geolocation=(), payment=()",
    },
    {
      key: options.enforce ? "Content-Security-Policy" : "Content-Security-Policy-Report-Only",
      value: directives.join("; "),
    },
  ];
  if (!options.dev) {
    // Two years, subdomains included. `preload` deliberately not yet: it is irreversible.
    headers.unshift({
      key: "Strict-Transport-Security",
      value: "max-age=63072000; includeSubDomains",
    });
  }
  return headers;
}
