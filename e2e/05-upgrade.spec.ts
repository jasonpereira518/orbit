import { expect, test } from "@playwright/test";
import { untilHydrated } from "./helpers";

const STRIPE_READY = ["STRIPE_SECRET_KEY", "STRIPE_LIFETIME_PRICE_ID", "STRIPE_PRO_MONTHLY_PRICE_ID", "STRIPE_PRO_ANNUAL_PRICE_ID"]
  .every((name) => Boolean(process.env[name]?.trim()));

test("the upgrade page offers both plans", async ({ page }) => {
  await page.goto("/upgrade");
  await expect(page.getByRole("heading", { name: /Pick how you.d like to pay/ })).toBeVisible();
  await expect(page.getByText("Orbit Pro", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("Orbit Lifetime", { exact: true }).first()).toBeVisible();
});

test("Lifetime opens Stripe Checkout", async ({ page }) => {
  test.skip(!STRIPE_READY, "export test-mode STRIPE_SECRET_KEY and the three price ids to run this");
  await page.goto("/upgrade");
  await expect(page.getByRole("button", { name: /^Start Pro — / })).toBeVisible();
  const lifetime = page.getByRole("button", { name: /^Get Orbit Lifetime — \$/ });
  await expect(lifetime).toBeVisible();
  await untilHydrated(
    () => lifetime.click(),
    () => expect(page).toHaveURL(/^https:\/\/checkout\.stripe\.com\//, { timeout: 60_000 })
  );
});
