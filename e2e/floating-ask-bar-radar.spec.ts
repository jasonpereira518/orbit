import { test, expect } from "@playwright/test";
import { ensureOnboarded } from "./helpers";

// The floating Ask bar hides on /radar until Radar is turned on (the Turn on button sits where it floats).
test("Ask bar is absent on /radar until Radar is on, present elsewhere", async ({ page }) => {
  await page.setViewportSize({ width: 1512, height: 731 });
  await ensureOnboarded(page);
  const bar = page.getByRole("textbox", { name: "Ask your network" });

  // The bar is a lazy chunk: seeing it on the dashboard proves it has had time to appear.
  await page.goto("/dashboard", { waitUntil: "domcontentloaded" });
  await expect(bar).toBeVisible({ timeout: 90_000 });

  await page.goto("/radar", { waitUntil: "domcontentloaded" });
  const turnOn = page.getByRole("button", { name: "Turn on Radar" });
  await expect(turnOn).toBeVisible({ timeout: 90_000 });
  await page.waitForTimeout(1500);
  await expect(bar).toHaveCount(0);

  // Turn it on (reduced motion skips the full-screen scene).
  await page.emulateMedia({ reducedMotion: "reduce" });
  await turnOn.click();
  await expect(bar).toBeVisible({ timeout: 90_000 });
  await expect(page.getByRole("button", { name: "Turn on Radar" })).toHaveCount(0);

  await page.goto("/dashboard", { waitUntil: "domcontentloaded" });
  await expect(bar).toBeVisible({ timeout: 90_000 });

  // Leave the shared e2e account as found: Radar off, so the Turn on screen is back.
  await page.goto("/radar", { waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: "Settings" }).click();
  const radarSwitch = page.getByRole("switch", { name: "Radar on" });
  await radarSwitch.click();
  // Switching off re-renders the page back to the Turn on screen.
  await expect(page.getByRole("button", { name: "Turn on Radar" })).toBeVisible({ timeout: 90_000 });
});
