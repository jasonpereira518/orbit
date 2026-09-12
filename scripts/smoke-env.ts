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
import { validateEnv, REQUIRED_IN_PRODUCTION } from "../src/lib/env";

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

  const preview = validateEnv(
    { DATABASE_URL: GOOD.DATABASE_URL, NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: "pk_test_x", CLERK_SECRET_KEY: "sk_test_x", ENCRYPTION_SECRET: GOOD.ENCRYPTION_SECRET },
    { vercelEnv: "preview" }
  );
  check("preview needs only DB, Clerk and encryption", preview.errors.length === 0, preview.errors.join("; "));
  check("preview accepts test-mode keys", !preview.errors.some((e) => e.includes("pk_test")));

  const dev = validateEnv({}, { vercelEnv: undefined });
  check("local dev with nothing set has no errors", dev.errors.length === 0, dev.errors.join("; "));
  check("local dev still warns about what production would need", dev.warnings.length > 0);

  console.log("\nAll env checks passed.");
}

main();
