import { expect, test } from "@playwright/test";
import { createContact, ensureOnboarded, fillUntilEnabled, untilHydrated } from "./helpers";

const RECORD_COUNT = /^\d[\d,]* records?$/;

// Runs against the throwaway PGlite that playwright.config.ts creates, never a real account.
test("Settings → Delete data empties the account", async ({ page }) => {
  await ensureOnboarded(page);
  await createContact(page, "Katherine Johnson");

  await page.goto("/settings");
  const plan = page.getByText(/Unlimited contacts — \d+ in your orbit\./);
  await expect(plan).toBeVisible();
  await expect(plan).not.toHaveText("Unlimited contacts — 0 in your orbit.");

  const dialog = page.getByRole("dialog", { name: "Delete your Orbit data" });
  await untilHydrated(
    () => page.getByRole("button", { name: "Delete data…" }).click(),
    () => expect(dialog).toBeVisible({ timeout: 5_000 })
  );
  await expect(dialog.getByText(RECORD_COUNT).first()).toBeVisible();
  const confirm = dialog.getByRole("button", { name: "Delete everything" });
  await fillUntilEnabled(dialog.getByPlaceholder("delete"), "delete", confirm);
  await confirm.click();
  await expect(page.getByText("All data deleted")).toBeVisible({ timeout: 60_000 });

  await page.reload();
  await expect(page.getByText("Unlimited contacts — 0 in your orbit.")).toBeVisible();
  await untilHydrated(
    () => page.getByRole("button", { name: "Delete data…" }).click(),
    () => expect(dialog).toBeVisible({ timeout: 5_000 })
  );
  await expect(dialog.getByText(RECORD_COUNT)).toHaveCount(0);
});
