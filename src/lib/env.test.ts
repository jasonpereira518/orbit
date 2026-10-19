/** Characterization of `validateEnv` and the two migration guards (plan P0.4). */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  EXPECTED_IN_PRODUCTION,
  REQUIRED_IN_PREVIEW,
  REQUIRED_IN_PRODUCTION,
  checkMigrationTarget,
  databaseHost,
  validateEnv,
} from "@/lib/env";

type Bag = Record<string, string | undefined>;

const LONG = "x".repeat(40);

/** A production env that passes with zero errors (warnings aside). */
const GOOD_REQUIRED: Bag = {
  DATABASE_URL: "postgresql://u:p@db.prod.example.net/orbit",
  NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: "pk_live_abc",
  CLERK_SECRET_KEY: "sk_live_abc",
  CLERK_WEBHOOK_SIGNING_SECRET: "whsec_abc",
  ENCRYPTION_SECRET: LONG,
  CRON_SECRET: "c".repeat(16),
  APP_BASE_URL: "https://app.example.com",
  ADMIN_USER_IDS: "user_1",
  RESEND_API_KEY: "re_abc",
  RESEND_FROM_EMAIL: "Orbit <hi@example.com>",
};
const GOOD_EXPECTED: Bag = Object.fromEntries(EXPECTED_IN_PRODUCTION.map((k) => [k, "set-" + k]));
GOOD_EXPECTED.STRIPE_SECRET_KEY = "sk_live_abc";
GOOD_EXPECTED.STRIPE_WEBHOOK_SECRET = "whsec_stripe";
GOOD_EXPECTED.SLACK_BOT_TOKEN = "xoxb-1";
GOOD_EXPECTED.ANALYTICS_SALT = "s".repeat(16);
GOOD_EXPECTED.ORBIT_MANAGED_GEMINI_API_KEY = "k";

const prod = (over: Bag = {}): Bag => ({ ...GOOD_REQUIRED, ...GOOD_EXPECTED, ...over });
const run = (env: Bag, vercelEnv: "production" | "preview" | "development" | undefined) =>
  validateEnv(env, { vercelEnv });
const has = (list: string[], needle: string) => list.some((m) => m.includes(needle));

describe("validateEnv: production", () => {
  it("a complete env has no errors and no warnings", () => {
    const r = run(prod(), "production");
    assert.deepEqual(r, { errors: [], warnings: [], missingRequired: [], missingExpected: [] });
  });

  for (const name of REQUIRED_IN_PRODUCTION) {
    it(`missing ${name} -> '${name} is required in production'`, () => {
      const r = run(prod({ [name]: undefined }), "production");
      assert.ok(r.errors.includes(`${name} is required in production`), r.errors.join("|"));
      assert.deepEqual(r.missingRequired, [name]);
    });
  }

  it("a whitespace-only value counts as missing", () => {
    const r = run(prod({ CRON_SECRET: "   " }), "production");
    assert.deepEqual(r.missingRequired, ["CRON_SECRET"]);
  });

  it("everything missing reports every required name, in declared order", () => {
    const r = run({}, "production");
    assert.deepEqual(r.missingRequired, [...REQUIRED_IN_PRODUCTION]);
    assert.deepEqual(r.missingExpected, [...EXPECTED_IN_PRODUCTION]);
    assert.equal(r.errors.length, REQUIRED_IN_PRODUCTION.length);
    assert.equal(r.warnings.length, EXPECTED_IN_PRODUCTION.length);
  });

  describe("shape rules", () => {
    const shape: Array<[string, Bag, string]> = [
      ["DATABASE_URL not postgres", { DATABASE_URL: "mysql://x" }, "DATABASE_URL must be a postgres:// URL"],
      ["Clerk publishable key test", { NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: "pk_test_x" }, "NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY must be a live-instance key"],
      ["Clerk secret key test", { CLERK_SECRET_KEY: "sk_test_x" }, "CLERK_SECRET_KEY must be a live-instance key"],
      ["CLERK_JWT_KEY not PEM", { CLERK_JWT_KEY: "sk_live_pasted" }, "CLERK_JWT_KEY must be the instance's PEM public key"],
      ["ENCRYPTION_SECRET short", { ENCRYPTION_SECRET: "short" }, "ENCRYPTION_SECRET must be at least 32 characters"],
      ["ENCRYPTION_SECRET placeholder", { ENCRYPTION_SECRET: "change-me-to-a-long-random-string" }, "ENCRYPTION_SECRET must be at least 32 characters"],
      ["ANALYTICS_SALT short", { ANALYTICS_SALT: "short" }, "ANALYTICS_SALT must be at least 16 characters"],
      ["CRON_SECRET short", { CRON_SECRET: "short" }, "CRON_SECRET must be at least 16 characters"],
      ["APP_BASE_URL http", { APP_BASE_URL: "http://app.example.com" }, "APP_BASE_URL must be an https:// URL"],
      ["STRIPE_SECRET_KEY test", { STRIPE_SECRET_KEY: "sk_test_x" }, "STRIPE_SECRET_KEY must be a live key"],
      ["SLACK_BOT_TOKEN wrong prefix", { SLACK_BOT_TOKEN: "xoxp-1" }, "SLACK_BOT_TOKEN must be a bot token"],
    ];
    for (const [label, over, expected] of shape) {
      it(label, () => {
        const r = run(prod(over), "production");
        assert.equal(r.errors.length, 1, r.errors.join("|"));
        assert.ok(has(r.errors, expected), r.errors.join("|"));
        assert.deepEqual(r.missingRequired, []);
      });
    }

    it("valid CLERK_JWT_KEY PEM passes", () => {
      const pem = "-----BEGIN PUBLIC KEY-----\nabc\n-----END PUBLIC KEY-----";
      assert.deepEqual(run(prod({ CLERK_JWT_KEY: pem }), "production").errors, []);
    });

    it("an unset optional (ANALYTICS_SALT) is a warning, not a shape error", () => {
      const r = run(prod({ ANALYTICS_SALT: undefined }), "production");
      assert.deepEqual(r.errors, []);
      assert.deepEqual(r.missingExpected, ["ANALYTICS_SALT"]);
    });

    it("shape checks do not run on a missing var (only the 'required' error appears)", () => {
      const r = run(prod({ DATABASE_URL: undefined }), "production");
      assert.deepEqual(r.errors, ["DATABASE_URL is required in production"]);
    });
  });

  describe("conditional rules", () => {
    it("STRIPE_SECRET_KEY set without STRIPE_WEBHOOK_SECRET", () => {
      const r = run(prod({ STRIPE_WEBHOOK_SECRET: undefined }), "production");
      assert.deepEqual(r.errors, ["STRIPE_WEBHOOK_SECRET is required when STRIPE_SECRET_KEY is set"]);
    });

    it("SLACK_BOT_TOKEN and SLACK_ALERT_USER_ID must be set together (both directions)", () => {
      const a = run(prod({ SLACK_ALERT_USER_ID: undefined }), "production");
      assert.ok(has(a.errors, "must be set together"));
      const b = run(prod({ SLACK_BOT_TOKEN: undefined }), "production");
      assert.ok(has(b.errors, "must be set together"));
    });

    it("WAITLIST_HOST requires WAITLIST_FROM_EMAIL", () => {
      const r = run(prod({ WAITLIST_HOST: "waitlist.other.io" }), "production");
      assert.deepEqual(r.errors, ["WAITLIST_FROM_EMAIL is required when WAITLIST_HOST is set"]);
    });

    it("waitlist sender on the app's own domain (or a subdomain of it) is an error", () => {
      const r = run(
        prod({ WAITLIST_HOST: "waitlist.other.io", WAITLIST_FROM_EMAIL: "Hi <w@mail.example.com>", WAITLIST_REPLY_TO: "r@example.com" }),
        "production"
      );
      assert.deepEqual(r.errors, [
        "WAITLIST_FROM_EMAIL must not be on the app's own domain",
        "WAITLIST_REPLY_TO must not be on the app's own domain",
      ]);
    });

    it("a gmail.com RESEND_FROM_EMAIL is not treated as the app's domain", () => {
      const r = run(
        prod({
          APP_BASE_URL: "https://app.example.com",
          RESEND_FROM_EMAIL: "me@gmail.com",
          WAITLIST_HOST: "w.other.io",
          WAITLIST_FROM_EMAIL: "x@gmail.com",
        }),
        "production"
      );
      assert.deepEqual(r.errors, []);
    });

    it("WAITLIST_BASE_URL must be https", () => {
      const r = run(
        prod({ WAITLIST_HOST: "w.other.io", WAITLIST_FROM_EMAIL: "x@other.io", WAITLIST_BASE_URL: "http://w.other.io" }),
        "production"
      );
      assert.deepEqual(r.errors, ["WAITLIST_BASE_URL must be an https:// URL in production"]);
    });

    it("managed-AI warning: Stripe on, no managed key, not switched off", () => {
      const r = run(prod({ ORBIT_MANAGED_GEMINI_API_KEY: undefined }), "production");
      assert.deepEqual(r.errors, []);
      assert.equal(r.warnings.length, 1);
      assert.ok(has(r.warnings, "No ORBIT_MANAGED_*_API_KEY is set"));
    });

    it("managed-AI warning is silenced by ORBIT_MANAGED_AI=off (any case) or no Stripe key", () => {
      assert.deepEqual(run(prod({ ORBIT_MANAGED_GEMINI_API_KEY: undefined, ORBIT_MANAGED_AI: " OFF " }), "production").warnings, []);
      const noStripe = run(prod({ ORBIT_MANAGED_GEMINI_API_KEY: undefined, STRIPE_SECRET_KEY: undefined, STRIPE_WEBHOOK_SECRET: undefined }), "production");
      assert.ok(!has(noStripe.warnings, "ORBIT_MANAGED"));
    });
  });

  describe("FORBIDDEN_IN_PRODUCTION", () => {
    for (const name of ["DEMO_ACCOUNT_USER_ID", "EXTENSION_DEV_SECRET"]) {
      it(`${name} set -> error`, () => {
        const r = run(prod({ [name]: "anything" }), "production");
        assert.deepEqual(r.errors, [`${name} must not be set in production`]);
      });
    }
  });

  it("each EXPECTED_IN_PRODUCTION var missing -> a warning and a missingExpected entry", () => {
    for (const name of EXPECTED_IN_PRODUCTION) {
      const r = run(prod({ [name]: undefined }), "production");
      // Removing STRIPE_SECRET_KEY / SLACK_BOT_TOKEN also changes conditional rules; assert only the warning.
      assert.ok(r.warnings.includes(`${name} is unset; the feature it enables is off`), name);
      assert.ok(r.missingExpected.includes(name), name);
    }
  });
});

describe("validateEnv: preview", () => {
  const previewOk: Bag = {
    DATABASE_URL: "x",
    NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: "x",
    CLERK_SECRET_KEY: "x",
    ENCRYPTION_SECRET: "x",
  };

  for (const name of REQUIRED_IN_PREVIEW) {
    it(`missing ${name} -> error '${name} is required in preview deployments'`, () => {
      const r = run({ ...previewOk, [name]: undefined }, "preview");
      assert.deepEqual(r.errors, [`${name} is required in preview deployments`]);
      assert.deepEqual(r.missingRequired, [name]);
    });
  }

  it("applies NO shape checks (test keys, short secrets, http, mysql all pass)", () => {
    const r = run(
      {
        DATABASE_URL: "mysql://nope",
        NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: "pk_test_x",
        CLERK_SECRET_KEY: "sk_test_x",
        ENCRYPTION_SECRET: "short",
        APP_BASE_URL: "http://x",
        DEMO_ACCOUNT_USER_ID: "forbidden-in-prod-only",
        STRIPE_SECRET_KEY: "sk_test_x",
      },
      "preview"
    );
    assert.deepEqual(r.errors, []);
  });

  it("other production-required vars are warnings; PRODUCTION_DB_HOST unset is a warning", () => {
    const r = run(previewOk, "preview");
    const others = REQUIRED_IN_PRODUCTION.filter((n) => !(REQUIRED_IN_PREVIEW as readonly string[]).includes(n));
    assert.deepEqual(
      r.warnings,
      [...others.map((n) => `${n} is unset (required in production)`), "PRODUCTION_DB_HOST is unset; the preview-migration guard is unarmed"]
    );
    assert.deepEqual(r.missingExpected, []);
  });

  it("PRODUCTION_DB_HOST set silences the guard warning", () => {
    const r = run({ ...previewOk, PRODUCTION_DB_HOST: "h" }, "preview");
    assert.ok(!has(r.warnings, "PRODUCTION_DB_HOST"));
  });
});

describe("validateEnv: development / undefined", () => {
  for (const vercelEnv of [undefined, "development"] as const) {
    it(`${vercelEnv ?? "undefined"}: never errors; each missing prod-required var is a warning`, () => {
      const r = run({}, vercelEnv);
      assert.deepEqual(r.errors, []);
      assert.deepEqual(r.warnings, REQUIRED_IN_PRODUCTION.map((n) => `${n} is unset (required in production)`));
      assert.deepEqual(r.missingRequired, []);
      assert.deepEqual(r.missingExpected, []);
    });
  }

  it("no shape checks and forbidden vars are allowed", () => {
    const r = run({ ...GOOD_REQUIRED, DATABASE_URL: "mysql://x", DEMO_ACCOUNT_USER_ID: "u" }, undefined);
    assert.deepEqual(r, { errors: [], warnings: [], missingRequired: [], missingExpected: [] });
  });
});

describe("databaseHost", () => {
  it("lowercases the hostname, never the credentials; null for junk", () => {
    assert.equal(databaseHost("postgres://u:p@DB.Example.NET:5432/x"), "db.example.net");
    assert.equal(databaseHost("not a url"), null);
    assert.equal(databaseHost("  "), null);
    assert.equal(databaseHost(undefined), null);
  });
});

describe("checkMigrationTarget", () => {
  const url = "postgres://u:p@prod.db.net/x";
  it("not a Vercel build -> allowed", () => {
    const v = checkMigrationTarget({ DATABASE_URL: url, PRODUCTION_DB_HOST: "prod.db.net" }, { vercelEnv: "preview" });
    assert.equal(v.allowed, true);
    assert.equal(v.unarmed, undefined);
  });
  it("production build -> allowed even if it names the production host", () => {
    assert.equal(
      checkMigrationTarget({ VERCEL: "1", DATABASE_URL: url, PRODUCTION_DB_HOST: "prod.db.net" }, { vercelEnv: "production" }).allowed,
      true
    );
  });
  it("preview without PRODUCTION_DB_HOST -> allowed but unarmed (not fail-closed)", () => {
    const v = checkMigrationTarget({ VERCEL: "1", DATABASE_URL: url }, { vercelEnv: "preview" });
    assert.equal(v.allowed, true);
    assert.equal(v.unarmed, true);
  });
  it("preview pointed at the production host -> refused, host named, no credentials", () => {
    const v = checkMigrationTarget({ VERCEL: "1", DATABASE_URL: url, PRODUCTION_DB_HOST: " PROD.db.net " }, { vercelEnv: "preview" });
    assert.equal(v.allowed, false);
    assert.ok(v.reason.includes("prod.db.net"));
    assert.ok(!v.reason.includes("u:p"));
  });
  it("preview on its own branch, or an unparseable URL -> allowed", () => {
    assert.equal(checkMigrationTarget({ VERCEL: "1", DATABASE_URL: "postgres://a@branch.db.net/x", PRODUCTION_DB_HOST: "prod.db.net" }, { vercelEnv: "preview" }).allowed, true);
    const bad = checkMigrationTarget({ VERCEL: "1", DATABASE_URL: "junk", PRODUCTION_DB_HOST: "prod.db.net" }, { vercelEnv: "preview" });
    assert.equal(bad.allowed, true);
    assert.ok(bad.reason.includes("(unparseable)"));
  });
  it("a development VERCEL_ENV is treated like preview", () => {
    assert.equal(checkMigrationTarget({ VERCEL: "1", DATABASE_URL: url, PRODUCTION_DB_HOST: "prod.db.net" }, { vercelEnv: "development" }).allowed, false);
  });
});
