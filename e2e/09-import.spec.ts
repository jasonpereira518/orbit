import { expect, test } from "@playwright/test";
import { join } from "node:path";
import { ensureOnboarded, untilHydrated } from "./helpers";

/**
 * The LinkedIn Connections.csv import over the real /imports page: pick the file, review
 * the preview, confirm, and find the people in /contacts. Pins the path through
 * `previewLinkedInCsv`, `startImportJob` and `runImportJob` that P8.6/P8.7 refactor.
 */
const PEOPLE = ["Grace Hopper", "Alan Turing", "Katherine Johnson"];

test("a LinkedIn connections CSV previews, imports on confirm, and lands in contacts", async ({ page }) => {
  await ensureOnboarded(page);
  await page.goto("/imports");

  // The page-wide drop zone owns the first CSV-accepting file input: it stages the file in
  // a "Ready to import" queue (preview) and imports nothing until "Import" is pressed.
  const picker = page.locator('input[type="file"][accept*=".csv"]').first();
  const queued = page.getByText("linkedin-connections.csv — 3 of 3 selected");
  await untilHydrated(
    () => picker.setInputFiles(join(__dirname, "fixtures", "linkedin-connections.csv")),
    () => expect(queued).toBeVisible({ timeout: 15_000 })
  );
  await expect(page.getByRole("heading", { name: "Ready to import" })).toBeVisible();
  await expect(page.getByText("3 people selected")).toBeVisible();

  // Review lists every row as a new person; dropping one narrows what gets imported.
  await page.getByRole("button", { name: "Review" }).click();
  for (const name of PEOPLE) {
    await expect(page.getByRole("checkbox", { name: `Select ${name}` })).toBeChecked();
  }
  await expect(page.getByText("Already in orbit")).toHaveCount(0);
  await page.getByRole("checkbox", { name: "Select Alan Turing" }).uncheck();
  await expect(page.getByText("2 people selected")).toBeVisible();

  // Confirm.
  await page.getByRole("button", { name: "Import", exact: true }).click();
  await expect(page.getByText(/^Imported: /).first()).toBeVisible({ timeout: 90_000 });

  await page.goto("/contacts");
  await expect(page.getByText("Grace Hopper").first()).toBeVisible();
  await expect(page.getByText("Katherine Johnson").first()).toBeVisible();
  await expect(page.getByText("Alan Turing")).toHaveCount(0);
});
