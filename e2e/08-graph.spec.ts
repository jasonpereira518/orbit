import { expect, test } from "@playwright/test";
import { createContact, ensureOnboarded } from "./helpers";

/**
 * The constellation at /graph over the real page: the star chart renders, a star opens the
 * inspect panel, and search narrows the sky. Pins what P8.5 keeps while it splits
 * GraphCanvasInner. The e2e account starts empty (no demo data), so this makes its own people.
 * They have no notes yet, so the chart lists them only under "Show all".
 */
const PEOPLE = ["Orion Vega", "Lyra Chen"];

test("the constellation renders, a star opens the inspect panel, and search narrows the sky", async ({ page }) => {
  await ensureOnboarded(page);
  for (const name of PEOPLE) await createContact(page, name);

  await page.goto("/graph");
  await expect(page.getByRole("heading", { level: 1, name: "Constellation" })).toBeVisible();
  // You are the sun: the canvas always has the account's own node.
  const sun = page.locator(".react-flow__node-user");
  await expect(sun).toContainText("Demo User", { timeout: 90_000 });
  await expect(page.getByPlaceholder("Search name, role, school, keywords…")).toBeVisible();

  // People without notes are not in the default sky; "Show all" brings everyone in.
  const star = (name: string) => page.locator(".react-flow__node-contact").filter({ hasText: name });
  const showAll = page.getByRole("button", { name: /^Show all \d+/ });
  await expect(async () => {
    if (await showAll.isVisible()) await showAll.click();
    await expect(star(PEOPLE[0])).toBeVisible({ timeout: 3_000 });
  }).toPass({ timeout: 60_000 });
  await expect(star(PEOPLE[1])).toBeVisible();

  // Selecting a star opens the inspect panel for that person.
  await expect(async () => {
    await star(PEOPLE[0]).click();
    await expect(page.getByRole("dialog").getByRole("link", { name: "Open full profile" })).toBeVisible({ timeout: 3_000 });
  }).toPass({ timeout: 30_000 });
  const panel = page.getByRole("dialog");
  await expect(panel).toContainText(PEOPLE[0]);
  await expect(panel.getByRole("link", { name: "Open full profile" })).toHaveAttribute("href", /^\/contacts\/[0-9a-f-]+$/);
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toBeHidden();

  // Search keeps the match and drops the other star.
  await page.getByPlaceholder("Search name, role, school, keywords…").fill("Lyra");
  await expect(star(PEOPLE[0])).toHaveCount(0);
  await expect(star(PEOPLE[1])).toBeVisible();
});
