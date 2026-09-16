import { expect, test } from "@playwright/test";

test("an empty account goes through onboarding and lands on the empty dashboard", async ({ page }) => {
  await page.goto("/dashboard");
  await expect(page).toHaveURL(/\/onboarding/);
  await expect(page.getByRole("heading", { name: "Welcome to Orbit" })).toBeVisible();
  await page.getByRole("button", { name: "Skip tour" }).click();
  await expect(page).toHaveURL(/\/dashboard$/);
  await expect(page.getByRole("heading", { name: "Your orbit is empty" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Capture notes" })).toBeVisible();
});
