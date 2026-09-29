import { expect, test } from "@playwright/test";
import { untilHydrated } from "./helpers";

// Pricing v2 resolves prices by lookup key, so a test-mode secret key is all checkout needs
// (the prices themselves come from `scripts/stripe-pricing-v2.ts --mode test --apply`).
const STRIPE_READY = Boolean(process.env.STRIPE_SECRET_KEY?.trim().startsWith("sk_test_"));

test("the upgrade page offers Pro and Max, never Lifetime", async ({ page }) => {
  await page.goto("/upgrade");
  await expect(page.getByRole("heading", { name: /Pick your plan/ })).toBeVisible();
  await expect(page.getByText("Orbit Pro", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("Orbit Max", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("Orbit Lifetime", { exact: true })).toHaveCount(0);
  await expect(page.getByText(/at cost|never charges you for AI/i)).toHaveCount(0);
});

test("the pricing page lists Free, Pro and Max and explains credits", async ({ page }) => {
  await page.goto("/pricing");
  for (const name of ["Free Plan", "Orbit Pro", "Orbit Max"]) {
    await expect(page.getByRole("heading", { name, exact: true })).toBeVisible();
  }
  await expect(page.getByRole("heading", { name: /What.s a credit\?/ })).toBeVisible();
  await expect(page.getByText("$8.99", { exact: true })).toBeVisible();
  await expect(page.getByText("$19.99", { exact: true })).toBeVisible();
  // No Lifetime card, no popularity badge, no billing-period toggle.
  await expect(page.getByRole("heading", { name: "Orbit Lifetime" })).toHaveCount(0);
  await expect(page.getByText(/Most popular|Best value/i)).toHaveCount(0);
  await expect(page.getByRole("radio", { name: /Annual/ })).toHaveCount(0);
});

test("Max opens Stripe Checkout", async ({ page }) => {
  test.skip(!STRIPE_READY, "export a test-mode STRIPE_SECRET_KEY to run this");
  await page.goto("/upgrade");
  await expect(page.getByRole("button", { name: /^Start Pro — \$8\.99\/month/ })).toBeVisible();
  const max = page.getByRole("button", { name: /^Start Max — \$19\.99\/month/ });
  await expect(max).toBeVisible();
  await untilHydrated(
    () => max.click(),
    () => expect(page).toHaveURL(/^https:\/\/checkout\.stripe\.com\//, { timeout: 60_000 })
  );
});
