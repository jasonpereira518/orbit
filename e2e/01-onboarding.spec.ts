import { expect, test } from "@playwright/test";
import { fillUntilEnabled, skipConnectIfShown, untilHydrated } from "./helpers";

// Starts with the name: the Gemini stub returns the first "First Last" pair as the person. A
// name no other spec uses, so the capture spec's own person stays new there.
const NOTE =
  "Katherine Johnson leads flight research at Langley Labs. Met her at the career fair; she said to send my resume.";

/**
 * Quick setup, end to end, on an empty account: the welcome's one action, a first person from
 * notes, and the first win shown back before the dashboard. The e2e account runs on the Gemini
 * stub key, so capture runs; no Google or Microsoft client is configured, so nothing offers to
 * connect. The guided tour has its own spec.
 */
test("an empty account adds its first person and sees the first win", async ({ page }) => {
  await page.goto("/dashboard");
  await expect(page).toHaveURL(/\/onboarding/);
  await expect(page.getByRole("heading", { name: "Welcome to Orbit" })).toBeVisible();

  // No Clerk here, so no recorded consent: the checkbox gates every way on.
  const consent = page.getByRole("checkbox", { name: /Terms of Service/ });
  const start = page.getByRole("button", { name: "Add someone you met" });
  await expect(start).toBeDisabled();
  await expect(page.getByRole("button", { name: "Show me around with example people first" })).toBeDisabled();
  await untilHydrated(
    () => consent.click(),
    () => expect(start).toBeEnabled({ timeout: 2_000 })
  );
  await start.click();

  await expect(page.getByRole("heading", { name: "Who did you meet recently?" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Type their details instead" })).toBeVisible();
  const extract = page.getByRole("button", { name: "Extract people" });
  await fillUntilEnabled(page.getByLabel("Your notes"), NOTE, extract);
  await extract.click();

  await expect(page.getByRole("group", { name: "1 of 1: Katherine Johnson" })).toBeVisible({ timeout: 90_000 });
  await page.getByRole("button", { name: "Keep this person" }).click();
  await page.getByRole("button", { name: /^Save 1 contact/ }).click();

  // The first win, not a tour of features: the person, and the way on to the dashboard.
  await skipConnectIfShown(page, page.getByRole("heading", { name: "Katherine is in your network" }));
  await expect(page.getByRole("heading", { name: "Katherine is in your network" })).toBeVisible({ timeout: 60_000 });
  await expect(page.getByText("Katherine Johnson").first()).toBeVisible();
  await expect(page.getByRole("heading", { name: "Here’s what Orbit can do" })).toHaveCount(0);
  await page.getByRole("button", { name: "Go to my dashboard" }).click();

  await expect(page).toHaveURL(/\/dashboard$/, { timeout: 10_000 });
  await expect(page.getByText("Katherine Johnson").first()).toBeVisible();
});
