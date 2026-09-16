import { expect, test } from "@playwright/test";
import { untilHydrated } from "./helpers";

test("an empty account goes through onboarding and lands on the empty dashboard", async ({ page }) => {
  await page.goto("/dashboard");
  await expect(page).toHaveURL(/\/onboarding/);
  await expect(page.getByRole("heading", { name: "Welcome to Orbit" })).toBeVisible();
  await untilHydrated(
    () => page.getByRole("button", { name: "Skip tour" }).click(),
    () => expect(page).toHaveURL(/\/dashboard$/, { timeout: 5_000 })
  );
  await expect(page.getByRole("heading", { name: "Your orbit is empty" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Capture notes" })).toBeVisible();
});
