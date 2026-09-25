import { expect, test } from "@playwright/test";
import { ensureOnboarded, skipConnectIfShown, untilHydrated } from "./helpers";

/**
 * The guided tour over the real pages. Started from Settings → Help so it works whatever
 * state the shared e2e account is in, walked through the stops whose predicates the stub
 * environment can satisfy (search, open, log, clear a reminder), skipped through the AI
 * ones, and finished — at which point the example people must be gone.
 *
 * Last in file order on purpose: it seeds and removes rows other specs would see.
 */
test("the guided tour walks the real pages with example people, then removes them", async ({ page }) => {
  test.setTimeout(300_000);
  const rail = page.locator("[data-tour-rail]:visible");

  // Past the first-run gate first (a fresh e2e database redirects every page to /onboarding),
  // then warm the pages the tour pushes to: `next dev` compiles each route on first visit,
  // and the constellation is the heaviest, so a first compile mid-tour would read as a
  // navigation that never happened.
  await ensureOnboarded(page);
  for (const route of ["/graph", "/imports", "/reminders", "/chat", "/capture", "/contacts"]) {
    await page.goto(route);
    await expect(page).toHaveURL(new RegExp(`${route}$`), { timeout: 120_000 });
  }

  await page.goto("/settings");
  await untilHydrated(
    () => page.getByRole("button", { name: "Take the tour again" }).click(),
    () => expect(page).toHaveURL(/\/onboarding/, { timeout: 10_000 })
  );
  await expect(page.getByRole("heading", { name: "Welcome to Orbit" })).toBeVisible();
  const consent = page.getByRole("checkbox", { name: /Terms of Service/ });
  const start = page.getByRole("button", { name: "Start the tour" });
  await untilHydrated(
    async () => {
      if (await consent.isVisible()) await consent.check();
      await start.click();
    },
    () => expect(page.getByRole("heading", { name: "Start your LinkedIn export" })).toBeVisible({ timeout: 5_000 })
  );
  // The stub key skips the AI key step; connect shows only where an OAuth client is set up.
  await page.getByRole("button", { name: "I don't use LinkedIn" }).click();
  await skipConnectIfShown(page, page.getByRole("heading", { name: "Setting the stage" }));
  await expect(page).toHaveURL(/\/dashboard$/, { timeout: 60_000 });

  // Stop 1: the dashboard, with the example people in place.
  await expect(rail).toContainText("Stop 1 of", { timeout: 30_000 });
  await expect(rail).toContainText("Your dashboard");
  await rail.getByRole("button", { name: "Next" }).click();

  // Stop 2: search finds an example person and the rail advances on its own.
  await expect(page).toHaveURL(/\/contacts$/, { timeout: 60_000 });
  await expect(rail).toContainText("Find anyone in a keystroke");
  await page.getByLabel("Search contacts").fill("Maya");
  await expect(rail).toContainText("Open a person", { timeout: 15_000 });

  // Stop 3: opening a person is the predicate.
  await page.locator('li[role="link"]').first().click();
  await expect(page).toHaveURL(/\/contacts\/[^/]+$/, { timeout: 60_000 });
  await expect(rail).toContainText("Log what happened", { timeout: 15_000 });
  await expect(page.getByText("Example", { exact: true }).first()).toBeVisible();

  // Stop 4: log an interaction through the real sheet.
  const sheet = page.getByRole("dialog");
  await untilHydrated(
    () => page.getByRole("button", { name: "Log interaction", exact: true }).first().click(),
    () => expect(sheet.getByText("Log an interaction")).toBeVisible({ timeout: 5_000 })
  );
  await sheet.getByLabel("Notes").fill("Coffee — she’s moving to Berlin in March.");
  await sheet.getByRole("button", { name: "Log interaction", exact: true }).click();
  await expect(rail).toContainText("Logged, nice", { timeout: 60_000 });

  // Stop 5: capture needs a real extraction; skip it. "Review, then keep" depends on it, so
  // the tour goes straight past it rather than waiting for cards that never appear.
  await expect(page).toHaveURL(/\/capture$/, { timeout: 60_000 });
  await expect(rail).toContainText("Capture from messy notes", { timeout: 15_000 });
  await rail.getByRole("button", { name: "Skip this" }).click();

  // Stop 7: clear an example reminder.
  await expect(page).toHaveURL(/\/reminders$/, { timeout: 60_000 });
  await expect(rail).toContainText("Clear what’s due", { timeout: 15_000 });
  await page.locator('[data-tour="reminders.row-done"]').first().click();
  await expect(rail).toContainText("Done", { timeout: 30_000 });

  // Stops 8–9: chat and the sky; skip.
  await expect(page).toHaveURL(/\/chat$/, { timeout: 60_000 });
  await expect(rail).toContainText("Ask your network", { timeout: 15_000 });
  await rail.getByRole("button", { name: "Skip this" }).click();
  await expect(page).toHaveURL(/\/graph$/, { timeout: 60_000 });
  await expect(rail).toContainText("Your network as a sky", { timeout: 15_000 });
  await rail.getByRole("button", { name: "Skip this" }).click();

  // Stop 10: imports, then the finish card.
  await expect(page).toHaveURL(/\/imports$/, { timeout: 60_000 });
  // "I don't use LinkedIn" on the stage: the stop explains the export instead of waiting for it.
  await expect(rail).toContainText("Bring in everyone you know", { timeout: 15_000 });
  await rail.getByRole("button", { name: "Next" }).click();
  await expect(rail).toContainText("You’re in orbit", { timeout: 60_000 });
  await rail.getByRole("button", { name: "Go to your dashboard" }).click();

  await expect(page).toHaveURL(/\/dashboard$/, { timeout: 60_000 });
  await expect(page.locator("[data-tour-rail]")).toHaveCount(0, { timeout: 30_000 });
  await page.goto("/contacts");
  await expect(page.getByText("Example", { exact: true })).toHaveCount(0);
  await expect(page.getByText("Maya Okonkwo-Reyes")).toHaveCount(0);
});
