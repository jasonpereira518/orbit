import { expect, type Page } from "@playwright/test";

/** Past the onboarding gate: a new account is redirected from /dashboard to /onboarding. */
export async function ensureOnboarded(page: Page): Promise<void> {
  await page.goto("/dashboard");
  if (new URL(page.url()).pathname.startsWith("/onboarding")) {
    await page.getByRole("button", { name: "Skip tour" }).click();
    await page.waitForURL(/\/dashboard$/);
  }
}

/** Creates a contact through /contacts/new and waits on its profile. */
export async function createContact(page: Page, fullName: string): Promise<void> {
  await page.goto("/contacts/new");
  // The form's labels have no htmlFor; the placeholder is the stable handle.
  await page.getByPlaceholder("Jason Pereira").fill(fullName);
  await page.getByRole("button", { name: "Create contact" }).click();
  await page.waitForURL((url) => /^\/contacts\/[^/]+$/.test(url.pathname) && !url.pathname.endsWith("/new"));
  await expect(page.getByRole("heading", { level: 1, name: fullName })).toBeVisible();
}
