import { expect, test } from "@playwright/test";
import { ensureOnboarded, fillUntilEnabled } from "./helpers";

// Starts with the name: the Gemini stub returns the first "First Last" pair as the person.
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
