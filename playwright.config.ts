import { defineConfig, devices } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Browser flows against `next dev` in demo mode: no Clerk keys (every request is demo-user),
 * a throwaway PGlite, an empty account (ORBIT_DEMO_DATA=off) and a local Gemini stub.
 * Stop any dev server in this worktree first — two `next dev`s sharing one `.next` wedge.
 */
const PORT = Number(process.env.E2E_PORT ?? 3001);
const AI_STUB_PORT = Number(process.env.E2E_AI_STUB_PORT ?? 3999);
// The config is evaluated by the runner and every worker; the env var makes them agree.
const PGLITE_DIR: string = process.env.E2E_PGLITE_DIR || mkdtempSync(join(tmpdir(), "orbit-e2e-"));
process.env.E2E_PGLITE_DIR = PGLITE_DIR;

export default defineConfig({
  testDir: "./e2e",
  testMatch: /.*\.spec\.ts$/,
  // One account and one single-writer PGlite behind one server: flows share state, so they
  // run one at a time, in file-name order.
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  timeout: 180_000,
  expect: { timeout: 30_000 },
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
  use: { baseURL: `http://localhost:${PORT}`, trace: "retain-on-failure", navigationTimeout: 120_000 },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: [
    {
      command: "node e2e/ai-stub-server.mjs",
      url: `http://127.0.0.1:${AI_STUB_PORT}/health`,
      env: { AI_STUB_PORT: String(AI_STUB_PORT) },
      reuseExistingServer: false,
      timeout: 15_000,
    },
    {
      command: `./node_modules/.bin/next dev --port ${PORT}`,
      // 200 only once the schema is reconciled on the fresh PGlite.
      url: `http://localhost:${PORT}/api/health`,
      reuseExistingServer: false,
      timeout: 240_000,
      env: {
        DATABASE_URL: "",
        NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: "",
        CLERK_SECRET_KEY: "",
        ORBIT_DEMO_DATA: "off",
        ORBIT_PGLITE_DIR: PGLITE_DIR,
        GEMINI_API_KEY: "e2e-stub-key",
        OPENAI_API_KEY: "",
        ANTHROPIC_API_KEY: "",
        GOOGLE_GEMINI_BASE_URL: `http://127.0.0.1:${AI_STUB_PORT}`,
        NEXT_TELEMETRY_DISABLED: "1",
        // From the shell only, never a checkout's .env.local, so a local run renders /upgrade
        // exactly as CI does. Export test-mode keys to run the Checkout flow.
        STRIPE_SECRET_KEY: process.env.STRIPE_SECRET_KEY ?? "",
        STRIPE_LIFETIME_PRICE_ID: process.env.STRIPE_LIFETIME_PRICE_ID ?? "",
        STRIPE_PRO_MONTHLY_PRICE_ID: process.env.STRIPE_PRO_MONTHLY_PRICE_ID ?? "",
        STRIPE_PRO_ANNUAL_PRICE_ID: process.env.STRIPE_PRO_ANNUAL_PRICE_ID ?? "",
      },
    },
  ],
});
