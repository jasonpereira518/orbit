import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

/**
 * Local rule: in a file whose first statement is the "use client" directive, a value import of
 * server-only code is an error. Type-only imports are erased and always fine.
 */
const SERVER_ONLY_MODULES = new Set([
  "@/db",
  "@/lib/report-error",
  "@/lib/ai-access",
  "@/lib/auth",
  "@/lib/internal-auth",
  "@/lib/crypto",
  "stripe",
  "resend",
  "twilio",
  "@vercel/blob",
  "drizzle-orm",
  "@neondatabase/serverless",
  "@electric-sql/pglite",
]);
const orbitPlugin = {
  rules: {
    "no-server-imports-in-client": {
      meta: { type: "problem", schema: [] },
      create(context) {
        let isClient = false;
        return {
          Program(node) {
            isClient = node.body.some((n) => n.type === "ExpressionStatement" && n.directive === "use client");
          },
          ImportDeclaration(node) {
            if (!isClient || node.importKind === "type") return;
            if (node.specifiers.length > 0 && node.specifiers.every((sp) => sp.importKind === "type")) return;
            const source = node.source.value;
            const banned =
              SERVER_ONLY_MODULES.has(source) ||
              source.startsWith("node:") ||
              source.startsWith("@/db/");
            if (banned) {
              context.report({
                node,
                message: `"use client" files must not import server-only code (${source}). Call a server action, or import only types.`,
              });
            }
          },
        };
      },
    },
  },
};

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    rules: {
      // Baseline, 2026-09-02: 25 `set-state-in-effect` and 11 `refs` findings across the
      // client components. Both are React Compiler readiness rules, not bug detectors, and
      // fixing them is a per-component refactor. Warnings keep them visible in every lint
      // run and in CI logs; errors would block every unrelated PR. Flip back to "error"
      // once the count is zero (tracked in the production-readiness plan, Phase 6).
      "react-hooks/set-state-in-effect": "warn",
      "react-hooks/refs": "warn",
      // `const { score: _score, ...rest } = row` is the idiom for dropping a key; the
      // sibling is the point, not an oversight.
      "@typescript-eslint/no-unused-vars": [
        "error",
        { ignoreRestSiblings: true, argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
    },
  },
  // Typed rules (plan P3). `projectService` reads tsconfig.json, which is why the two
  // `.well-known` routes are listed in its `include`: its `**/*.ts` glob skips dot-directories.
  // Typed linting roughly doubles lint time (~75 s); the rules below are the ones that find
  // real defects or are safe autofixes.
  {
    files: ["src/**/*.{ts,tsx}"],
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    linterOptions: { reportUnusedDisableDirectives: "error" },
    rules: {
      // `typeof import("x")` types are deliberate here (they type a lazily imported module
      // without loading it, e.g. Sentry in report-error.ts), so only the import-statement
      // half of the rule is enforced.
      "@typescript-eslint/consistent-type-imports": [
        "error",
        { fixStyle: "inline-type-imports", disallowTypeAnnotations: false },
      ],
      "@typescript-eslint/no-unnecessary-type-assertion": "error",
      "@typescript-eslint/await-thenable": "error",
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-misused-promises": ["error", { checksVoidReturn: { attributes: false } }],
      "@typescript-eslint/switch-exhaustiveness-check": ["error", { considerDefaultExhaustiveForUnions: true }],
    },
  },
  // node:test's describe()/it() return promises by design; awaiting each would be noise.
  {
    files: ["**/*.test.{ts,tsx}"],
    rules: { "@typescript-eslint/no-floating-promises": "off" },
  },
  // ---- Boundaries (plan P3.3) -------------------------------------------------------------
  // The client/server split holds by discipline today (an import-graph search found no client
  // file reaching the database or a server SDK) and `server-only` cannot enforce it: its
  // default export throws under plain Node, which would break the ~285 tsx smoke scripts. A
  // lint rule gives the same protection without that cost.
  //
  // 1. Only the AI gate may import a provider SDK (replaces the regex in smoke-ai-access).
  {
    files: ["src/**/*.{ts,tsx}"],
    ignores: [
      "src/lib/ai.ts",
      "src/lib/ai-tools.ts",
      "src/lib/ai-access.ts",
      "src/lib/ai-batch.ts",
      "src/lib/ai-key-check.ts",
    ],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: ["@anthropic-ai/sdk", "openai", "@google/genai"].map((name) => ({
            name,
            message: "Provider SDKs are imported only by src/lib/ai*.ts. Go through src/lib/ai.ts / ai-access.ts.",
          })),
          patterns: [{ group: ["@anthropic-ai/sdk/*", "openai/*", "@google/genai/*"], message: "Go through src/lib/ai.ts." }],
        },
      ],
    },
  },
  // 2. A file that starts with "use client" must not reach the database or a server SDK.
  //    Decided by the directive, not a path glob: src/components also holds server components
  //    (which may import @/lib/auth), and 37 client files live in src/lib.
  {
    files: ["src/**/*.{ts,tsx}"],
    ignores: ["**/*.test.{ts,tsx}"],
    plugins: { orbit: orbitPlugin },
    rules: { "orbit/no-server-imports-in-client": "error" },
  },
  // 3. Domain code must not depend on UI components (value imports; types are tolerated).
  //    Warning at today's count, ratcheted by scripts/lint-ratchet.mjs.
  {
    files: ["src/lib/**/*.{ts,tsx}"],
    ignores: ["src/lib/**/use-*.{ts,tsx}", "**/*.test.{ts,tsx}"],
    rules: {
      "@typescript-eslint/no-restricted-imports": [
        "warn",
        { patterns: [{ group: ["@/components/*"], allowTypeImports: true, message: "src/lib must not depend on src/components; move the shared data into src/lib." }] },
      ],
    },
  },
  // 4. Route handlers should call lib, not server actions (an action re-runs auth and is a
  //    public endpoint). Plan P6.2 removes the remaining imports.
  {
    files: ["src/app/api/**/*.{ts,tsx}"],
    ignores: ["**/*.test.{ts,tsx}"],
    rules: {
      "@typescript-eslint/no-restricted-imports": [
        "warn",
        { patterns: [{ group: ["@/actions/*"], message: "Route handlers should call src/lib, not a server action." }] },
      ],
    },
  },
  // ---- Conventions (plan P3.4), warnings ratcheted at their current counts -----------------
  {
    files: ["src/**/*.{ts,tsx}"],
    ignores: [
      "**/*.test.{ts,tsx}",
      "src/test-support/**",
      // Modules that own a family of variables. Everything else should read through
      // src/lib/env.ts or one of these (plan P10.1).
      "src/lib/env.ts",
      "src/lib/app-url.ts",
      "src/lib/ai-access.ts",
      "src/lib/crypto.ts",
      "src/lib/deepgram.ts",
      "src/lib/internal-auth.ts",
      "src/lib/waitlist-host.ts",
      "src/db/index.ts",
      "src/instrumentation*.ts",
      "src/proxy.ts",
    ],
    rules: {
      "no-restricted-syntax": [
        "warn",
        {
          // Platform and framework variables (NODE_ENV, VERCEL*, NEXT_*) are fine anywhere.
          selector:
            "MemberExpression[object.object.name='process'][object.property.name='env'][property.name!=/^(NEXT_PUBLIC_|NODE_ENV$|VERCEL|NEXT_RUNTIME$|NEXT_PHASE$|CI$)/]",
          message: "Read configuration through src/lib/env.ts (or the module that owns the variable), not process.env.",
        },
      ],
    },
  },
  {
    files: ["src/actions/**/*.ts"],
    ignores: ["**/*.test.ts"],
    rules: {
      "no-restricted-syntax": [
        "warn",
        {
          selector:
            "MemberExpression[object.object.name='process'][object.property.name='env'][property.name!=/^(NEXT_PUBLIC_|NODE_ENV$|VERCEL|NEXT_RUNTIME$|NEXT_PHASE$|CI$)/]",
          message: "Read configuration through src/lib/env.ts (or the module that owns the variable), not process.env.",
        },
        {
          selector:
            // `ok: false` and `ok: false as const` (the common spelling) both count.
            "ReturnStatement > ObjectExpression:has(Property[key.name='ok']:matches([value.value=false], [value.expression.value=false])):has(Property[key.name='message'])",
          message: "Return the shared ActionResult shape ({ ok: false, error }) from @/lib/errors, not { ok: false, message }.",
        },
      ],
    },
  },
  // Server code reports caught errors through `reportError` (src/lib/report-error.ts), which
  // reaches Sentry and prints one greppable `[orbit:<where>] ref=<ref>` line. A bare
  // `console.error` reaches only Vercel's runtime log, which keeps it about an hour (audit
  // A5). `console.warn` stays allowed for expected-degradation notices. Client components,
  // scripts and tests are out of scope; src/db and instrumentation are not matched.
  {
    files: ["src/actions/**/*.{ts,tsx}", "src/lib/**/*.{ts,tsx}", "src/app/**/*.{ts,tsx}"],
    ignores: [
      "**/*.test.{ts,tsx}",
      // The reporter itself logs; the demo seeders are local-dev only.
      "src/lib/report-error.ts",
      "src/lib/demo-data/**",
    ],
    rules: { "no-console": ["error", { allow: ["warn"] }] },
  },
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Claude Code session data — contains full repo worktrees.
    ".claude/**",
    // The browser extension is a separate project with its own config.
    "extension/**",
  ]),
]);

export default eslintConfig;
