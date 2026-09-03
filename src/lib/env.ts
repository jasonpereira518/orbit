/**
 * The production environment contract.
 *
 * Every variable Orbit reads is read lazily at its call site behind an ad-hoc guard, so a
 * missing one degrades silently: checkout hides itself, calendar links point at a
 * per-deploy host, four job routes answer 401 to the app itself. This is the one place
 * that states what production REQUIRES. `scripts/check-env.ts` runs it in the Vercel
 * build, so a misconfigured deploy fails before it is aliased and the last good one stays
 * live; `instrumentation.ts` logs it at boot as a second line of defence.
 *
 * Pure and dependency-free on purpose: imported by scripts and by the health probe, and
 * it must never reach `@/db`. Errors name variables, never values.
 */

export type VercelEnv = "production" | "preview" | "development" | undefined;

export const REQUIRED_IN_PRODUCTION = [
  "DATABASE_URL",
  "NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY",
  "CLERK_SECRET_KEY",
  "CLERK_WEBHOOK_SIGNING_SECRET",
  "ENCRYPTION_SECRET",
  "CRON_SECRET",
  "APP_BASE_URL",
  "ADMIN_USER_IDS",
  "RESEND_API_KEY",
  "RESEND_FROM_EMAIL",
] as const;

/** Absent → a feature is quietly off. Worth a warning, not a failed build. */
export const EXPECTED_IN_PRODUCTION = [
  "STRIPE_SECRET_KEY",
  "BLOB_READ_WRITE_TOKEN",
  "SLACK_OPS_WEBHOOK_URL",
  "HEALTH_TOKEN",
  "SENTRY_DSN",
  "NEXT_PUBLIC_SENTRY_DSN",
] as const;

export const REQUIRED_IN_PREVIEW = [
  "DATABASE_URL",
  "NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY",
  "CLERK_SECRET_KEY",
  "ENCRYPTION_SECRET",
] as const;

const STRIPE_PRICE_IDS = [
  "STRIPE_LIFETIME_PRICE_ID",
  "STRIPE_LIFETIME_STANDARD_PRICE_ID",
  "STRIPE_PRO_MONTHLY_PRICE_ID",
  "STRIPE_PRO_ANNUAL_PRICE_ID",
] as const;

/** Must never be set in production: each one hands out access on a keypress or a header. */
const FORBIDDEN_IN_PRODUCTION = ["DEMO_ACCOUNT_USER_ID", "EXTENSION_DEV_SECRET"] as const;

const ENCRYPTION_PLACEHOLDER = "change-me-to-a-long-random-string";

export type EnvReport = {
  errors: string[];
  warnings: string[];
  /** Names from REQUIRED_IN_PRODUCTION that are unset. Feeds the ops sweep's `config.missing`. */
  missingRequired: string[];
};

type EnvBag = Record<string, string | undefined>;

const has = (env: EnvBag, name: string) => Boolean(env[name]?.trim());

export function validateEnv(env: EnvBag, options: { vercelEnv: VercelEnv }): EnvReport {
  const errors: string[] = [];
  const warnings: string[] = [];
  const missingRequired: string[] = [];

  if (options.vercelEnv === "production") {
    for (const name of REQUIRED_IN_PRODUCTION) {
      if (!has(env, name)) {
        errors.push(`${name} is required in production`);
        missingRequired.push(name);
      }
    }
    if (has(env, "DATABASE_URL") && !/^postgres(ql)?:\/\//.test(env.DATABASE_URL!)) {
      errors.push("DATABASE_URL must be a postgres:// URL");
    }
    if (has(env, "NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY") && !env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY!.startsWith("pk_live_")) {
      errors.push("NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY must be a live-instance key (pk_live_) in production");
    }
    if (has(env, "CLERK_SECRET_KEY") && !env.CLERK_SECRET_KEY!.startsWith("sk_live_")) {
      errors.push("CLERK_SECRET_KEY must be a live-instance key (sk_live_) in production");
    }
    if (has(env, "ENCRYPTION_SECRET")) {
      const secret = env.ENCRYPTION_SECRET!.trim();
      if (secret.length < 32 || secret === ENCRYPTION_PLACEHOLDER) {
        errors.push("ENCRYPTION_SECRET must be at least 32 characters and not the .env.example placeholder");
      }
    }
    if (has(env, "CRON_SECRET") && env.CRON_SECRET!.trim().length < 16) {
      errors.push("CRON_SECRET must be at least 16 characters");
    }
    if (has(env, "APP_BASE_URL") && !env.APP_BASE_URL!.startsWith("https://")) {
      errors.push("APP_BASE_URL must be an https:// URL in production");
    }

    if (has(env, "STRIPE_SECRET_KEY")) {
      if (!env.STRIPE_SECRET_KEY!.startsWith("sk_live_")) {
        errors.push("STRIPE_SECRET_KEY must be a live key (sk_live_) in production — test-mode prices fail checkout");
      }
      for (const name of ["STRIPE_WEBHOOK_SECRET", ...STRIPE_PRICE_IDS]) {
        if (!has(env, name)) errors.push(`${name} is required when STRIPE_SECRET_KEY is set`);
      }
    }

    for (const name of FORBIDDEN_IN_PRODUCTION) {
      if (has(env, name)) errors.push(`${name} must not be set in production`);
    }

    for (const name of EXPECTED_IN_PRODUCTION) {
      if (!has(env, name)) warnings.push(`${name} is unset; the feature it enables is off`);
    }
    return { errors, warnings, missingRequired };
  }

  if (options.vercelEnv === "preview") {
    for (const name of REQUIRED_IN_PREVIEW) {
      if (!has(env, name)) {
        errors.push(`${name} is required in preview deployments`);
        missingRequired.push(name);
      }
    }
    for (const name of REQUIRED_IN_PRODUCTION) {
      if (!has(env, name) && !(REQUIRED_IN_PREVIEW as readonly string[]).includes(name)) {
        warnings.push(`${name} is unset (required in production)`);
      }
    }
    return { errors, warnings, missingRequired };
  }

  // Local development and CI: nothing is required — PGlite and demo mode cover the rest.
  for (const name of REQUIRED_IN_PRODUCTION) {
    if (!has(env, name)) warnings.push(`${name} is unset (required in production)`);
  }
  return { errors, warnings, missingRequired };
}

/** The report for this process. */
export function getEnvReport(): EnvReport {
  return validateEnv(process.env, { vercelEnv: process.env.VERCEL_ENV as VercelEnv });
}
