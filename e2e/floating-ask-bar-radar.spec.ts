import { test, expect, type Page } from "@playwright/test";
import { ensureOnboarded } from "./helpers";

/**
 * Turn Radar off for the shared e2e account if it is on, so the test starts from the
 * Turn on screen whatever an earlier run (or a timed-out attempt of this one) left behind.
 */
async function radarOff(page: Page) {
  await page.goto("/radar", { waitUntil: "domcontentloaded" });
  const turnOn = page.getByRole("button", { name: "Turn on Radar" });
  const settings = page.getByRole("button", { name: "Settings" });
  // Whichever screen renders first says which state Radar is in.
  await expect(turnOn.or(settings).first()).toBeVisible({ timeout: 90_000 });
  if (await turnOn.isVisible()) return;
  await settings.click();
  await page.getByRole("switch", { name: "Radar on" }).click();
  // Switching off re-renders the page back to the Turn on screen.
  await expect(turnOn).toBeVisible({ timeout: 90_000 });
}

// The floating Ask bar hides on /radar until Radar is turned on (the Turn on button sits where it floats).
test("Ask bar is absent on /radar until Radar is on, present elsewhere", async ({ page }) => {
  // Several cold page loads, each allowed 90 s on a slow runner: more than the default 3 minutes.
  test.setTimeout(360_000);
  await page.setViewportSize({ width: 1512, height: 731 });
  await ensureOnboarded(page);
  const bar = page.getByRole("textbox", { name: "Ask your network" });

  // The bar is a lazy chunk: seeing it on the dashboard proves it has had time to appear.
  await page.goto("/dashboard", { waitUntil: "domcontentloaded" });
  await expect(bar).toBeVisible({ timeout: 90_000 });

  await radarOff(page);
  try {
    const turnOn = page.getByRole("button", { name: "Turn on Radar" });
    await page.waitForTimeout(1500);
    await expect(bar).toHaveCount(0);

    // Turn it on (reduced motion skips the full-screen scene).
    await page.emulateMedia({ reducedMotion: "reduce" });
    await turnOn.click();
    await expect(bar).toBeVisible({ timeout: 90_000 });
    await expect(page.getByRole("button", { name: "Turn on Radar" })).toHaveCount(0);

    await page.goto("/dashboard", { waitUntil: "domcontentloaded" });
    await expect(bar).toBeVisible({ timeout: 90_000 });
  } finally {
    // Leave the shared e2e account as found, even when an assertion above failed.
    await radarOff(page);
  }
});
