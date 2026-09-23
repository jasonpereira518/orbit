import { expect, test } from "@playwright/test";
import { untilHydrated } from "./helpers";

/**
 * Quick setup, end to end, on an empty account. The e2e account runs on the Gemini stub key
 * (so the AI key step is skipped) with no Google or Microsoft client configured (so the
 * connect step is skipped too): the walk is welcome → LinkedIn → people → overview.
 */
test("an empty account goes through quick setup and lands on the empty dashboard", async ({ page }) => {
  await page.goto("/dashboard");
  await expect(page).toHaveURL(/\/onboarding/);
  await expect(page.getByRole("heading", { name: "Welcome to Orbit" })).toBeVisible();

  // No Clerk here, so no recorded consent: the checkbox gates both path buttons.
  const consent = page.getByRole("checkbox", { name: /Terms of Service/ });
  const quick = page.getByRole("button", { name: "Set up quickly" });
  await expect(quick).toBeDisabled();
  await untilHydrated(
    () => consent.click(),
    () => expect(quick).toBeEnabled({ timeout: 2_000 })
  );
  await quick.click();

  await expect(page.getByRole("heading", { name: "Start your LinkedIn export" })).toBeVisible();
  await page.getByRole("button", { name: "I don't use LinkedIn" }).click();

  await expect(page.getByRole("heading", { name: "Add your first people" })).toBeVisible();
  await page.getByRole("button", { name: "I'll add people later" }).click();

  await expect(page.getByRole("heading", { name: "Here’s what Orbit can do" })).toBeVisible();
  // The overview lists Capture (which needs a key) and the dashboard; the account has a key
  // via the stub, so no "Needs AI key" tag anywhere.
  await expect(page.getByRole("heading", { name: "Capture people in seconds" })).toBeVisible();
  await expect(page.getByText("Needs AI key")).toHaveCount(0);
  await page.getByRole("button", { name: "Skip to the dashboard" }).click();

  await expect(page).toHaveURL(/\/dashboard$/, { timeout: 10_000 });
  await expect(page.getByRole("heading", { name: "Your orbit is empty" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Capture notes" })).toBeVisible();
});
