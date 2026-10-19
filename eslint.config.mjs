import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

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
