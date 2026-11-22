import { expect, test, type Page } from "@playwright/test";
import { ensureOnboarded } from "./helpers";

// A notes import leaves a backlog; the banner offers one click out, with Undo (UX fixes Task 12).
async function seed(page: Page, overdueFromNotes: number) {
  const res = await page.request.post("/api/e2e/seed-reminders", { data: { overdueFromNotes } });
  expect(res.ok()).toBe(true);
}

test("a small notes backlog shows no banner", async ({ page }) => {
  await ensureOnboarded(page);
  await seed(page, 5);
  await page.goto("/reminders");
  await expect(page.getByText("5 reminders", { exact: true })).toBeVisible({ timeout: 90_000 });
  await expect(page.getByText(/overdue reminders from your notes/)).toHaveCount(0);
});

test("snooze the backlog, then undo it", async ({ page }) => {
  await ensureOnboarded(page);
  await seed(page, 30);
  await page.goto("/reminders");
  const banner = page.getByRole("region", { name: "Overdue reminders from your notes" });
  await expect(banner).toContainText("30 overdue reminders from your notes", { timeout: 90_000 });
  await expect(banner.getByRole("button", { name: "Review" })).toBeVisible();
  await expect(page.getByText("30 reminders", { exact: true })).toBeVisible();

  await banner.getByRole("button", { name: "Snooze them" }).click();
  await expect(page.getByText(/Snoozed 30 reminders until/)).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText("30 reminders", { exact: true })).toHaveCount(0);
  await expect(banner).toHaveCount(0);

  await page.getByRole("button", { name: "Undo" }).click();
  await expect(page.getByText("30 reminders", { exact: true })).toBeVisible({ timeout: 30_000 });
  await expect(banner).toContainText("30 overdue reminders from your notes");
});
