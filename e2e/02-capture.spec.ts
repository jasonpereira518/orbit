import { expect, test } from "@playwright/test";
import { ensureOnboarded, fillUntilEnabled } from "./helpers";

// Starts with the name: the AI stub returns the first "First Last" pair as the person.
const NOTE =
  "Ada Lovelace runs analytics at Babbage Labs. We met at the AWS Summit afterparty and talked about difference engines.";

test("a pasted note becomes a review card, and keeping it adds the contact", async ({ page }) => {
  await ensureOnboarded(page);
  await page.goto("/capture");
  // `next dev` compiles /capture on first visit; see fillUntilEnabled.
  const extract = page.getByRole("button", { name: "Extract people" });
  await fillUntilEnabled(page.getByLabel("Your notes"), NOTE, extract);
  await extract.click();

  await expect(page.getByRole("group", { name: "1 of 1: Ada Lovelace" })).toBeVisible({ timeout: 90_000 });
  await page.getByRole("button", { name: "Keep this person" }).click();
  // Keeping the only person stops at the summary (suggested reminders live there); saving is its own step.
  await page.getByRole("button", { name: "Save 1 contact" }).click();
  await expect(page.getByRole("heading", { name: "Ada Lovelace is in your orbit" })).toBeVisible({ timeout: 60_000 });

  await page.goto("/contacts");
  await expect(page.getByText("Ada Lovelace").first()).toBeVisible();
});

// A saved meeting draft with no people. Fresh ones still reopen by themselves; one left for
// days must not take over the page (Task 2 of the UX walkthrough fixes).
async function seedMeetingDraft(page: import("@playwright/test").Page, ageMs: number): Promise<string> {
  const res = await page.request.post("/api/e2e/seed-capture-job", { data: { ageMs } });
  expect(res.ok()).toBe(true);
  return (await res.json()).id;
}
const DAY = 24 * 60 * 60 * 1000;

test("stale draft shows a notice, not the whole page", async ({ page }) => {
  await ensureOnboarded(page);
  await seedMeetingDraft(page, 4 * DAY);

  await page.goto("/capture");
  await expect(page.getByLabel("Your notes")).toBeVisible({ timeout: 90_000 });
  const notice = page.getByText(/Unsaved meeting from/);
  await expect(notice).toBeVisible();
  await expect(page.getByRole("heading", { name: "Ready to save" })).toHaveCount(0);

  await page.goto("/meetings");
  await expect(page.getByRole("heading", { name: "Past meetings" })).toBeInViewport({ timeout: 90_000 });
  await expect(page.getByText(/Unsaved meeting from/)).toBeVisible();

  await page.getByRole("button", { name: "Resume" }).click();
  await expect(page.getByRole("heading", { name: "Ready to save" })).toBeVisible({ timeout: 30_000 });
});

test("stale draft can be discarded from the notice", async ({ page }) => {
  await ensureOnboarded(page);
  await seedMeetingDraft(page, 4 * DAY);
  await page.goto("/capture");
  await expect(page.getByText(/Unsaved meeting from/)).toBeVisible({ timeout: 90_000 });
  await page.getByRole("button", { name: "Discard" }).click();
  await expect(page.getByText(/Unsaved meeting from/)).toHaveCount(0);
});

test("a fresh draft still opens straight to the summary", async ({ page }) => {
  await ensureOnboarded(page);
  await seedMeetingDraft(page, 5 * 60 * 1000);
  await page.goto("/capture");
  await expect(page.getByRole("heading", { name: "Ready to save" })).toBeVisible({ timeout: 90_000 });
  await expect(page.getByText(/Unsaved meeting from/)).toHaveCount(0);
});
