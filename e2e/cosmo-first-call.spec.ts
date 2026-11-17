import { test, expect, type Page } from "@playwright/test";
import { ensureOnboarded } from "./helpers";

// First Cosmo call per browser asks first; the orb and the "N things due" chip share the gate.
const KEY = "orbit:cosmo-first-call";

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
  await page.evaluate((k) => localStorage.removeItem(k), KEY);
  await page.reload({ waitUntil: "domcontentloaded" });
  return starts;
}

test("the first call asks before any voice request, then never again", async ({ page }) => {
  const starts = await setup(page);
  const orb = page.getByRole("button", { name: "Talk to Cosmo" });
  await expect(orb).toBeVisible();
  await expect(async () => {
    await orb.click();
    await expect(page.getByRole("dialog", { name: "Talk to Cosmo?" })).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 60_000 });
  await expect(page.getByText("Cosmo listens through your microphone. Calls use your voice minutes.")).toBeVisible();
  expect(starts).toHaveLength(0);

  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await orb.click();
  await page.getByRole("button", { name: "Not now" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(starts).toHaveLength(0);
  expect(await page.evaluate((k) => localStorage.getItem(k), KEY)).toBeNull();

  await orb.click();
  await page.getByRole("button", { name: "Start call" }).click();
  await expect.poll(() => starts.length).toBe(1);
  expect(await page.evaluate((k) => localStorage.getItem(k), KEY)).toBe("1");

  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(orb).toBeVisible();
  await orb.click();
  await expect.poll(() => starts.length).toBe(2);
  await expect(page.getByRole("dialog", { name: "Talk to Cosmo?" })).toHaveCount(0);
});

test("the chip and the keyboard pass through the same gate", async ({ page }) => {
  const starts = await setup(page);
  // A reminder due today makes the "N due" chip.
  await page.goto("/reminders", { waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: "New reminder" }).first().click();
  await page.getByPlaceholder("Call Alex about intro").fill("First-call chip check");
  await page.getByRole("button", { name: "Add reminder" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.goto("/dashboard", { waitUntil: "domcontentloaded" });
  const chip = page.locator(".cosmo-chip").getByRole("button", { name: /ask Cosmo$/ });
  await expect(chip).toBeVisible({ timeout: 30_000 });
  await chip.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("dialog", { name: "Talk to Cosmo?" })).toBeVisible();
  expect(starts).toHaveLength(0);
  await page.keyboard.press("Escape");
  const orb = page.getByRole("button", { name: "Talk to Cosmo" });
  await orb.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("dialog", { name: "Talk to Cosmo?" })).toBeVisible();
  expect(starts).toHaveLength(0);
});
