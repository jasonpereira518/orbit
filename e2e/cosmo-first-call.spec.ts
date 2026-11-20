import { test, expect, type Page } from "@playwright/test";
import { ensureOnboarded, untilHydrated } from "./helpers";


async function setup(page: Page) {
  const starts: unknown[] = [];
  await page.addInitScript(() => {
    navigator.mediaDevices.getUserMedia = async () => {
      const context = new AudioContext();
      const destination = context.createMediaStreamDestination();
      const oscillator = context.createOscillator();
      oscillator.connect(destination);
      oscillator.start();
      return destination.stream;
    };
  });
  await page.route("**/api/voice", async (route) => {
    if (route.request().method() === "GET")
      return route.fulfill({ json: { enabled: true, provider: "deepgram", fallbackProvider: null, revision: "first-call" } });
    if (route.request().postDataJSON().action === "start") starts.push(1);
    return route.fulfill({ status: 503, json: { error: "stubbed" } });
  });
  await page.goto("/dashboard", { waitUntil: "domcontentloaded" });
  if (new URL(page.url()).pathname.startsWith("/onboarding")) {
    await ensureOnboarded(page);
    await page.goto("/dashboard", { waitUntil: "domcontentloaded" });
  }
  return starts;
}

test("each call asks before any voice request", async ({ page }) => {
  const starts = await setup(page);
  const orb = page.getByRole("button", { name: "Cosmo voice", exact: true });
  await expect(orb).toBeVisible();
  await expect(async () => {
    await orb.click();
    await expect(page.getByRole("dialog", { name: "Cosmo voice" })).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 60_000 });
  await expect(page.getByText("Orbit uses your microphone and voice minutes during the call.")).toBeVisible();
  expect(starts).toHaveLength(0);

  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await orb.click();
  await page.getByRole("button", { name: "Cancel" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(starts).toHaveLength(0);

  await orb.click();
  await page.getByRole("button", { name: "Start voice call" }).click();
  await expect.poll(() => starts.length).toBe(1);

  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(orb).toBeVisible();
  await orb.click();
  await expect(page.getByRole('dialog', { name: 'Cosmo voice' })).toBeVisible();
  expect(starts).toHaveLength(1);
  await page.getByRole('button', { name: 'Start voice call' }).click();
  await expect.poll(() => starts.length).toBe(2);
  await expect(page.getByRole("dialog", { name: "Cosmo voice" })).toHaveCount(0);
});

test("the chip and the keyboard pass through the same gate", async ({ page }) => {
  const starts = await setup(page);
  // A reminder due today makes the "N due" chip. Unique per run, and cleared at the end.
  const title = `First-call chip check ${Date.now()}`;
  await page.goto("/reminders", { waitUntil: "domcontentloaded" });
  const titleInput = page.getByPlaceholder("Call Alex about intro");
  await untilHydrated(async () => {
    if (!(await titleInput.isVisible())) await page.getByRole("button", { name: "New reminder" }).first().click();
  }, () => expect(titleInput).toBeVisible({ timeout: 2_000 }));
  await titleInput.fill(title);
  await page.getByRole("button", { name: "Add reminder" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.goto("/dashboard", { waitUntil: "domcontentloaded" });
  const chip = page.locator(".cosmo-chip").getByRole("button", { name: /Cosmo voice$/ });
  await expect(chip).toBeVisible({ timeout: 30_000 });
  await chip.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("dialog", { name: "Cosmo voice" })).toBeVisible();
  expect(starts).toHaveLength(0);
  await page.keyboard.press("Escape");
  const orb = page.getByRole("button", { name: "Cosmo voice", exact: true });
  await orb.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("dialog", { name: "Cosmo voice" })).toBeVisible();
  expect(starts).toHaveLength(0);

  await page.keyboard.press("Escape");
  await page.goto("/reminders", { waitUntil: "domcontentloaded" });
  const row = page.getByText(title).first().locator('xpath=ancestor::*[.//*[@data-tour="reminders.row-done"]][1]');
  await row.locator('[data-tour="reminders.row-done"]').first().click();
});

test("denying the microphone after confirming still shows the error", async ({ page }) => {
  await setup(page);
  await page.evaluate(() => {
    navigator.mediaDevices.getUserMedia = async () => {
      throw new DOMException("Denied", "NotAllowedError");
    };
  });
  const orb = page.getByRole("button", { name: "Cosmo voice", exact: true });
  await orb.click();
  await page.getByRole("button", { name: "Start voice call" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "Microphone access was denied" })).toBeVisible();
});
