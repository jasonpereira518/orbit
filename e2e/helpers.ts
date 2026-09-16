import { expect, type Locator, type Page } from "@playwright/test";

/**
 * `next dev` compiles each route on first visit, so an action can land on the server-rendered
 * markup before React attaches and silently do nothing — a click that never navigates, a
 * fill the controlled input never hears. Repeat the action until its effect shows.
 */
export async function untilHydrated(action: () => Promise<void>, effect: () => Promise<void>): Promise<void> {
  await expect(async () => {
    await action();
    await effect();
  }).toPass({ timeout: 90_000 });
}

/** Fills a controlled input and waits until React has the value (the button enables). */
export async function fillUntilEnabled(input: Locator, value: string, button: Locator): Promise<void> {
  await untilHydrated(
    async () => {
      await input.fill("");
      await input.fill(value);
    },
    () => expect(button).toBeEnabled({ timeout: 2_000 })
  );
}

/** Past the onboarding gate: a new account is redirected from /dashboard to /onboarding. */
export async function ensureOnboarded(page: Page): Promise<void> {
  await page.goto("/dashboard");
  if (new URL(page.url()).pathname.startsWith("/onboarding")) {
    await untilHydrated(
      () => page.getByRole("button", { name: "Skip tour" }).click(),
      () => expect(page).toHaveURL(/\/dashboard$/, { timeout: 5_000 })
    );
  }
}

/** Creates a contact through /contacts/new and waits on its profile. */
export async function createContact(page: Page, fullName: string): Promise<void> {
  await page.goto("/contacts/new");
  // The form's labels have no htmlFor; the placeholder is the stable handle.
  const name = page.getByPlaceholder("Jason Pereira");
  const create = page.getByRole("button", { name: "Create contact" });
  await untilHydrated(
    async () => {
      await name.fill(fullName);
      await create.click();
    },
    () =>
      expect(page).toHaveURL((url) => /^\/contacts\/[^/]+$/.test(url.pathname) && !url.pathname.endsWith("/new"), {
        timeout: 10_000,
      })
  );
  await expect(page.getByRole("heading", { level: 1, name: fullName })).toBeVisible();
}
