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

/**
 * Past the onboarding gate: a new account is redirected from /dashboard to /onboarding.
 * The welcome has its own "Skip for now", behind the consent box an account without Clerk has
 * never ticked; past the welcome, "Skip setup" is in the header, and the first win (where
 * setup is already done) has "Go to my dashboard".
 */
export async function ensureOnboarded(page: Page): Promise<void> {
  await page.goto("/dashboard");
  if (new URL(page.url()).pathname.startsWith("/onboarding")) {
    // The stage resumes wherever the account left off (specs share one e2e database), so
    // this has to work from any step.
    const skip = page.getByRole("button", { name: "Skip setup" });
    const done = page.getByRole("button", { name: "Go to my dashboard" });
    const consent = page.getByRole("checkbox", { name: /Terms of Service/ });
    const skipWelcome = page.getByRole("button", { name: "Skip for now" });
    await untilHydrated(
      async () => {
        if (await skip.isVisible()) {
          await skip.click();
          return;
        }
        if (await done.isVisible()) {
          await done.click();
          return;
        }
        if (await consent.isVisible()) await consent.check();
        if (await skipWelcome.isVisible()) await skipWelcome.click();
      },
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

/**
 * The connect step appears only where a Google or Microsoft OAuth client is configured (a
 * worktree with the keys in .env.local, never CI). Skip it when it shows, so the specs pass
 * either way; the step after it is the caller's to wait for.
 */
export async function skipConnectIfShown(page: Page, next: Locator) {
  const connect = page.getByRole("heading", { name: "Bring in the people you email" });
  await expect(connect.or(next)).toBeVisible({ timeout: 30_000 });
  if (await connect.isVisible()) await page.getByRole("button", { name: /Skip for now/ }).click();
}
