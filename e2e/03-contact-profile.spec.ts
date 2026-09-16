import { expect, test } from "@playwright/test";
import { createContact, ensureOnboarded, untilHydrated } from "./helpers";

test("logging an interaction on a contact puts it on the timeline", async ({ page }) => {
  await ensureOnboarded(page);
  await createContact(page, "Grace Hopper");
  await expect(page.getByText("Nothing logged yet")).toBeVisible();

  const sheet = page.getByRole("dialog");
  await untilHydrated(
    () => page.getByRole("button", { name: "Log interaction", exact: true }).first().click(),
    () => expect(sheet.getByText("Log an interaction")).toBeVisible({ timeout: 5_000 })
  );
  // The sheet opened, so React is attached: a plain fill is heard.
  await sheet.getByLabel("Notes").fill("Grace Hopper walked me through compilers over coffee; she will send the COBOL paper.");
  await sheet.getByRole("button", { name: "Log interaction", exact: true }).click();

  await expect(page.getByText("Nothing logged yet")).toBeHidden({ timeout: 60_000 });
  const rows = page.locator('li[id^="interaction-"]');
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText("Today");
  // Guards the merge: another name here means the note landed on the wrong contact.
  await expect(page.getByRole("heading", { level: 1, name: "Grace Hopper" })).toBeVisible();
});
