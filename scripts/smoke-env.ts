/**
 * Asserts the production environment contract in `src/lib/env.ts`.
 *
 * Every variable Orbit reads is read lazily at its call site with an ad-hoc guard, so a
 * misconfigured deploy shows up hours later as a silently disabled feature — a hidden
 * checkout button, a calendar link on the wrong host, four job routes answering 401 to
 * the app itself. `validateEnv()` is the one place that says what production REQUIRES,
 * and `scripts/check-env.ts` runs it in the Vercel build so a bad deploy fails before it
 * is aliased, leaving the last good one in place.
 *
 * Pure: no database, no network. Run: npx tsx scripts/smoke-env.ts
 */
import { validateEnv, REQUIRED_IN_PRODUCTION, EXPECTED_IN_PRODUCTION } from "../src/lib/env";

function check(label: string, cond: boolean, detail?: string) {
  if (!cond) throw new Error(`${label} FAILED${detail ? `: ${detail}` : ""}`);
  console.log("  ok  " + label);
}

/** A complete, valid production environment. Each case below breaks one thing. */
const GOOD: Record<string, string> = {
  DATABASE_URL: "postgresql://user:pass@ep-x.us-east-1.aws.neon.tech/neondb?sslmode=require",
  NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: "pk_live_abc",
  CLERK_SECRET_KEY: "sk_live_abc",
  CLERK_WEBHOOK_SIGNING_SECRET: "whsec_abc",
  ENCRYPTION_SECRET: "a".repeat(40),
  CRON_SECRET: "b".repeat(24),
  APP_BASE_URL: "https://orbit.jasonpereira.live",
  ADMIN_USER_IDS: "user_123",
  RESEND_API_KEY: "re_abc",
  RESEND_FROM_EMAIL: "orbit@jasonpereira.live",
  STRIPE_SECRET_KEY: "sk_live_stripe",
  STRIPE_WEBHOOK_SECRET: "whsec_stripe",
  STRIPE_LIFETIME_PRICE_ID: "price_1",
  STRIPE_LIFETIME_STANDARD_PRICE_ID: "price_2",
  STRIPE_PRO_MONTHLY_PRICE_ID: "price_3",
  STRIPE_PRO_ANNUAL_PRICE_ID: "price_4",
  SLACK_OPS_WEBHOOK_URL: "https://hooks.slack.com/services/x",
  HEALTH_TOKEN: "c".repeat(24),
};

const prod = (over: Record<string, string | undefined>) =>
  validateEnv({ ...GOOD, ...over }, { vercelEnv: "production" });

function main() {
  console.log("Environment contract (validateEnv)...");

  const ok = prod({});
  check("a complete production env has no errors", ok.errors.length === 0, ok.errors.join("; "));

  for (const name of REQUIRED_IN_PRODUCTION) {
    const r = prod({ [name]: undefined });
    check(
      `production without ${name} is an error naming it`,
      r.errors.some((e) => e.includes(name)),
      r.errors.join("; ")
    );
  }

  check("errors never include values", !prod({ CRON_SECRET: undefined }).errors.join(" ").includes("b".repeat(24)));
  check(
    "test-mode Clerk key in production is an error",
    prod({ NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: "pk_test_abc" }).errors.some((e) => e.includes("NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY"))
  );
  check(
    "test-mode Stripe key in production is an error",
    prod({ STRIPE_SECRET_KEY: "sk_test_x" }).errors.some((e) => e.includes("STRIPE_SECRET_KEY"))
  );
  check(
    "Stripe key without all four price ids is an error",
    prod({ STRIPE_PRO_ANNUAL_PRICE_ID: undefined }).errors.some((e) => e.includes("STRIPE_PRO_ANNUAL_PRICE_ID"))
  );
  check(
    "no Stripe at all is allowed (checkout hides itself)",
    prod({
      STRIPE_SECRET_KEY: undefined,
      STRIPE_WEBHOOK_SECRET: undefined,
      STRIPE_LIFETIME_PRICE_ID: undefined,
      STRIPE_LIFETIME_STANDARD_PRICE_ID: undefined,
      STRIPE_PRO_MONTHLY_PRICE_ID: undefined,
      STRIPE_PRO_ANNUAL_PRICE_ID: undefined,
    }).errors.length === 0
  );
  check(
    "the .env.example placeholder ENCRYPTION_SECRET is an error",
    prod({ ENCRYPTION_SECRET: "change-me-to-a-long-random-string" }).errors.some((e) => e.includes("ENCRYPTION_SECRET"))
  );
  check("a short CRON_SECRET is an error", prod({ CRON_SECRET: "short" }).errors.some((e) => e.includes("CRON_SECRET")));
  check("no CLERK_JWT_KEY is allowed (Clerk fetches the JWKS)", !prod({ CLERK_JWT_KEY: undefined }).errors.some((e) => e.includes("CLERK_JWT_KEY")));
  check(
    "a PEM CLERK_JWT_KEY is accepted",
    !prod({ CLERK_JWT_KEY: "-----BEGIN PUBLIC KEY-----\nMIIBIjANBg\n-----END PUBLIC KEY-----" }).errors.some((e) => e.includes("CLERK_JWT_KEY"))
  );
  check(
    "a non-PEM CLERK_JWT_KEY is an error (it would sign everyone out)",
    prod({ CLERK_JWT_KEY: "sk_live_abc" }).errors.some((e) => e.includes("CLERK_JWT_KEY"))
  );
  check("an http APP_BASE_URL is an error", prod({ APP_BASE_URL: "http://orbit.test" }).errors.some((e) => e.includes("APP_BASE_URL")));
  check(
    "DEMO_ACCOUNT_USER_ID in production is an error",
    prod({ DEMO_ACCOUNT_USER_ID: "user_demo" }).errors.some((e) => e.includes("DEMO_ACCOUNT_USER_ID"))
  );
  check(
    "EXTENSION_DEV_SECRET in production is an error",
    prod({ EXTENSION_DEV_SECRET: "x" }).errors.some((e) => e.includes("EXTENSION_DEV_SECRET"))
  );
  check(
    "a missing Slack webhook is a warning, not an error",
    prod({ SLACK_OPS_WEBHOOK_URL: undefined }).errors.length === 0 &&
      prod({ SLACK_OPS_WEBHOOK_URL: undefined }).warnings.some((w) => w.includes("SLACK_OPS_WEBHOOK_URL"))
  );

  check(
    "missingExpected lists exactly the unset EXPECTED_IN_PRODUCTION names",
    JSON.stringify(prod({}).missingExpected) ===
      JSON.stringify(EXPECTED_IN_PRODUCTION.filter((n) => !GOOD[n])),
    JSON.stringify(prod({}).missingExpected)
  );
  check("an unset Slack webhook is in missingExpected",
    prod({ SLACK_OPS_WEBHOOK_URL: undefined }).missingExpected.includes("SLACK_OPS_WEBHOOK_URL"));
  check("off production missingExpected is always empty",
    validateEnv({}, { vercelEnv: undefined }).missingExpected.length === 0 &&
      validateEnv({}, { vercelEnv: "preview" }).missingExpected.length === 0);

  for (const name of [
    "SLACK_OPS_CRITICAL_WEBHOOK_URL", "BETTERSTACK_HEARTBEAT_URL", "RESEND_WEBHOOK_SECRET",
    "GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "GOOGLE_REDIRECT_URI",
  ]) {
    check(`${name} is expected in production`, (EXPECTED_IN_PRODUCTION as readonly string[]).includes(name));
    const r = prod({ [name]: undefined });
    check(`production without ${name} warns and never errors`,
      r.errors.length === 0 && r.warnings.some((w) => w.startsWith(name)), r.errors.join("; "));
  }

  const preview = validateEnv(
    { DATABASE_URL: GOOD.DATABASE_URL, NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: "pk_test_x", CLERK_SECRET_KEY: "sk_test_x", ENCRYPTION_SECRET: GOOD.ENCRYPTION_SECRET },
    { vercelEnv: "preview" }
  );
  check("preview needs only DB, Clerk and encryption", preview.errors.length === 0, preview.errors.join("; "));
  check("preview accepts test-mode keys", !preview.errors.some((e) => e.includes("pk_test")));

  const dev = validateEnv({}, { vercelEnv: undefined });
  check("local dev with nothing set has no errors", dev.errors.length === 0, dev.errors.join("; "));
  check("local dev still warns about what production would need", dev.warnings.length > 0);

  console.log("\nThe waitlist's own domain...");
  // Optional, but once set its mail must not come from the app's domain: that would print
  // the app's name in the From line of the one thing that must never show it.
  check("no waitlist host, no waitlist requirements", prod({}).errors.length === 0);
  const noSender = prod({ WAITLIST_HOST: "join.example" });
  check("a waitlist host needs its own sender", noSender.errors.some((e) => e.includes("WAITLIST_FROM_EMAIL")), noSender.errors.join("; "));
  const own = prod({ WAITLIST_HOST: "join.example", WAITLIST_FROM_EMAIL: "Jason <hello@join.example>" });
  check("a sender on the waitlist's own domain is fine", own.errors.length === 0, own.errors.join("; "));
  for (const leaky of ["hello@orbit.jasonpereira.live", "Jason <hi@jasonpereira.live>"]) {
    const r = prod({ WAITLIST_HOST: "join.example", WAITLIST_FROM_EMAIL: leaky });
    check(`a sender on the app's domain is refused (${leaky})`, r.errors.some((e) => e.includes("WAITLIST_FROM_EMAIL")), r.errors.join("; "));
  }
  const leakyReply = prod({ WAITLIST_HOST: "join.example", WAITLIST_FROM_EMAIL: "hello@join.example", WAITLIST_REPLY_TO: "orbit@jasonpereira.live" });
  check("a reply-to on the app's domain is refused", leakyReply.errors.some((e) => e.includes("WAITLIST_REPLY_TO")));
  const gmailSender = prod({
    RESEND_FROM_EMAIL: "someone@gmail.com",
    WAITLIST_HOST: "join.example",
    WAITLIST_FROM_EMAIL: "hello@join.example",
    WAITLIST_REPLY_TO: "someone.else@gmail.com",
  });
  check(
    "a Gmail app sender does not make every Gmail reply-to 'the app's domain'",
    gmailSender.errors.length === 0,
    gmailSender.errors.join("; ")
  );
  const insecure = prod({ WAITLIST_HOST: "join.example", WAITLIST_FROM_EMAIL: "hello@join.example", WAITLIST_BASE_URL: "http://join.example" });
  check("the waitlist base URL must be https", insecure.errors.some((e) => e.includes("WAITLIST_BASE_URL")));

  console.log("\nAll env checks passed.");
}

main();
