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
  // Not read by the app at all — it exists so `checkMigrationTarget` below can tell a
  // preview build pointed at its own Neon branch from one pointed at production.
  "PRODUCTION_DB_HOST",
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
    // A preview build runs db:migrate too. Without this, nothing can tell whether it is
    // about to write to its own Neon branch or to production. See `checkMigrationTarget`.
    if (!has(env, "PRODUCTION_DB_HOST")) {
      warnings.push("PRODUCTION_DB_HOST is unset; the preview-migration guard is unarmed");
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

/**
 * The host of a `postgres://` URL, or null if it is unparseable. Never the credentials.
 */
export function databaseHost(url: string | undefined): string | null {
  const raw = url?.trim();
  if (!raw) return null;
  try {
    const host = new URL(raw).hostname.toLowerCase();
    return host || null;
  } catch {
    return null;
  }
}

export type MigrationTargetVerdict = {
  allowed: boolean;
  /** Why, in a sentence, for the build log. Names variables and hosts, never credentials. */
  reason: string;
  /** True when the check ran but had nothing to compare against. */
  unarmed?: boolean;
};

/**
 * Whether this build may run `db:migrate` against the database it is pointed at.
 *
 * `vercel.json`'s build command runs `npm run db:migrate` in EVERY environment, and
 * `scripts/migrate.ts` reconciles DDL, backfills `contact_identities` and merges confident
 * duplicates — two of which write. If `DATABASE_URL` is scoped to "All Environments" in
 * Vercel (the default when a variable is added without picking environments), then every
 * pull-request preview build performs those writes against production customer data.
 *
 * The real fix is scoping the variable and giving previews their own Neon branch. This is
 * the backstop, because a guard that depends on a dashboard setting staying right is not a
 * guard. It compares the target host against `PRODUCTION_DB_HOST` — a hostname, not a
 * credential, so it is safe to set on all environments, which is exactly what makes it
 * readable from a preview build.
 *
 * Deliberately NOT fail-closed when `PRODUCTION_DB_HOST` is unset: refusing every preview
 * build until someone sets a new variable breaks previews to prevent a hypothetical, and a
 * broken preview pipeline is how guards get deleted. It reports `unarmed` instead, and
 * `check-env` warns.
 */
export function checkMigrationTarget(
  env: EnvBag,
  options: { vercelEnv: VercelEnv }
): MigrationTargetVerdict {
  if (!has(env, "VERCEL")) {
    return { allowed: true, reason: "not a Vercel build; the target is whatever DATABASE_URL says" };
  }
  if (options.vercelEnv === "production") {
    return { allowed: true, reason: "production build migrating the production database" };
  }

  const target = databaseHost(env.DATABASE_URL);
  const production = env.PRODUCTION_DB_HOST?.trim().toLowerCase();

  if (!production) {
    return {
      allowed: true,
      unarmed: true,
      reason:
        "PRODUCTION_DB_HOST is unset, so a preview build pointed at production cannot be told " +
        "from one pointed at its own branch. Set it (to the production database hostname) on " +
        "all environments to arm this check.",
    };
  }
  if (target && target === production) {
    return {
      allowed: false,
      reason:
        `VERCEL_ENV=${options.vercelEnv ?? "unset"} but DATABASE_URL points at ${target}, which ` +
        "PRODUCTION_DB_HOST names as production. This build would run DDL and the identity/duplicate " +
        "backfills against live customer data. Scope DATABASE_URL to Production only and give " +
        "previews their own Neon branch.",
    };
  }
  return { allowed: true, reason: `target ${target ?? "(unparseable)"} is not the production host` };
}
